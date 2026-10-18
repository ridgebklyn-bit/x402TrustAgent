/**
 * SSRF-hardened HTTP(S) fetch for user-supplied URLs.
 *
 * Policy (applied to the first URL and to every redirect target):
 *   - http: and https: only; no username/password in the URL; ports 80/443.
 *   - The hostname is resolved once per hop and EVERY returned address must
 *     be public. Any loopback, private, link-local, CGNAT, multicast,
 *     reserved, documentation or cloud-metadata address fails the whole
 *     request (a mixed public/private DNS answer is rejected, not filtered).
 *   - IPv6 is allowed only inside global unicast 2000::/3, minus special
 *     ranges. IPv4-mapped (::ffff:0:0/96), NAT64 (64:ff9b::/96), 6to4
 *     (2002::/16) and Teredo (2001::/32) forms are rejected outright.
 *     Encoded IPv4 forms (decimal, hex, octal, short) are normalised by the
 *     WHATWG URL parser before the check.
 *   - The connection is pinned to the validated address through a custom
 *     `lookup`, so a second DNS answer (rebinding) cannot change where the
 *     socket goes. The request still carries the original hostname for the
 *     Host header, TLS SNI and certificate verification.
 *   - Redirects are followed manually, re-validated per hop, max 3 hops.
 *   - Deadlines: connect timeout, plus one overall deadline across all hops.
 *   - Size limits on the raw body and on the decompressed body; only an
 *     allow-list of content types is read.
 *
 * Uses only Node built-ins (http, https, dns, net.BlockList, zlib). It needs
 * the Node.js runtime; on a runtime without these modules the import fails,
 * so it fails closed rather than falling back to an unrestricted fetch.
 */

import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import zlib from 'node:zlib';

export class SafeFetchError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'SafeFetchError';
    this.code = code;
    this.status = status;
  }
}

export const SAFE_FETCH_DEFAULTS = Object.freeze({
  allowedPorts: [80, 443],
  maxRedirects: 3,
  connectTimeoutMs: 5000,
  deadlineMs: 15000,
  maxBodyBytes: 5 * 1024 * 1024,
  maxDecodedBytes: 10 * 1024 * 1024,
  allowedContentTypes: ['text/html', 'application/xhtml+xml', 'text/plain', 'application/pdf'],
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
});

// IANA special-purpose IPv4 ranges plus RFC 6598 CGNAT. 169.254.0.0/16 covers
// the AWS/GCP/Azure metadata address; 100.64.0.0/10 covers Alibaba's.
const IPV4_BLOCKED = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.31.196.0', 24], ['192.52.193.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['192.175.48.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
];
// Inside 2000::/3: IETF special block (incl. Teredo), documentation, 6to4.
const IPV6_BLOCKED_INSIDE_GLOBAL = [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
];

const v4Blocked = new net.BlockList();
IPV4_BLOCKED.forEach(([a, p]) => v4Blocked.addSubnet(a, p, 'ipv4'));
const v6Global = new net.BlockList();
v6Global.addSubnet('2000::', 3, 'ipv6');
const v6Blocked = new net.BlockList();
IPV6_BLOCKED_INSIDE_GLOBAL.forEach(([a, p]) => v6Blocked.addSubnet(a, p, 'ipv6'));

export function isPublicAddress(address) {
  const ip = String(address).split('%')[0]; // drop any IPv6 zone id
  const family = net.isIP(ip);
  if (family === 4) return !v4Blocked.check(ip, 'ipv4');
  if (family === 6) return v6Global.check(ip, 'ipv6') && !v6Blocked.check(ip, 'ipv6');
  return false;
}

export function validateUrl(input, opts = SAFE_FETCH_DEFAULTS) {
  let url;
  try {
    url = new URL(String(input));
  } catch {
    throw new SafeFetchError('invalid_url', 'Not a valid URL', 400);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SafeFetchError('unsupported_protocol', 'Only http:// and https:// URLs are supported', 400);
  }
  if (url.username || url.password) {
    throw new SafeFetchError('credentials_in_url', 'URLs containing a username or password are not allowed', 400);
  }
  const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
  if (!opts.allowedPorts.includes(port)) {
    throw new SafeFetchError('port_not_allowed', `Port ${port} is not allowed`, 400);
  }
  let host = url.hostname;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!host) throw new SafeFetchError('invalid_url', 'URL has no host', 400);
  return { url, host, port };
}

async function defaultResolver(host) {
  return dns.promises.lookup(host, { all: true, verbatim: true });
}

async function resolvePublicAddress(host, resolver, remainingMs) {
  if (net.isIP(host)) {
    if (!isPublicAddress(host)) throw new SafeFetchError('destination_not_allowed', 'That address is not a public internet destination', 400);
    return { address: host, family: net.isIP(host) };
  }
  let timer;
  let answers;
  try {
    answers = await Promise.race([
      resolver(host),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new SafeFetchError('deadline_exceeded', 'Timed out resolving the hostname', 504)), remainingMs); }),
    ]);
  } catch (err) {
    if (err instanceof SafeFetchError) throw err;
    throw new SafeFetchError('dns_failed', 'Could not resolve the hostname', 502);
  } finally {
    clearTimeout(timer);
  }
  if (!Array.isArray(answers) || answers.length === 0) {
    throw new SafeFetchError('dns_failed', 'Could not resolve the hostname', 502);
  }
  for (const a of answers) {
    if (!a || !isPublicAddress(a.address)) {
      throw new SafeFetchError('destination_not_allowed', 'The hostname resolves to an address that is not a public internet destination', 400);
    }
  }
  const first = answers[0];
  return { address: first.address, family: first.family || net.isIP(first.address) };
}

function baseMimeType(contentType) {
  return String(contentType || '').split(';')[0].trim().toLowerCase();
}

function decodeBody(buf, encoding, maxDecodedBytes) {
  const enc = String(encoding || 'identity').trim().toLowerCase();
  try {
    if (enc === '' || enc === 'identity') {
      if (buf.length > maxDecodedBytes) throw new RangeError('too large');
      return buf;
    }
    if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buf, { maxOutputLength: maxDecodedBytes });
    if (enc === 'deflate') {
      try { return zlib.inflateSync(buf, { maxOutputLength: maxDecodedBytes }); }
      catch (e) { if (e instanceof RangeError || e.code === 'ERR_BUFFER_TOO_LARGE') throw e; return zlib.inflateRawSync(buf, { maxOutputLength: maxDecodedBytes }); }
    }
    if (enc === 'br') return zlib.brotliDecompressSync(buf, { maxOutputLength: maxDecodedBytes });
  } catch (e) {
    if (e instanceof RangeError || e.code === 'ERR_BUFFER_TOO_LARGE') {
      throw new SafeFetchError('decoded_too_large', 'The response is too large after decompression', 413);
    }
    throw new SafeFetchError('bad_encoding', 'The response body could not be decompressed', 502);
  }
  throw new SafeFetchError('unsupported_encoding', `Unsupported content-encoding "${enc}"`, 502);
}

function requestOnce(target, pinned, opts, deadlineAt) {
  const { url, host, port } = target;
  const requestImpl = opts.requestImpl || (url.protocol === 'https:' ? https.request : http.request);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, val) => { if (!settled) { settled = true; clearTimeout(deadlineTimer); clearTimeout(connectTimer); fn(val); } };

    const reqOptions = {
      method: 'GET',
      protocol: url.protocol,
      hostname: host,
      port,
      path: `${url.pathname}${url.search}`,
      headers: {
        'User-Agent': opts.userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/pdf;q=0.9,text/plain;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
      },
      agent: false,
      // Pin the socket to the address that passed validation.
      lookup: (_hostname, options, cb) => {
        if (options && options.all) cb(null, [{ address: pinned.address, family: pinned.family }]);
        else cb(null, pinned.address, pinned.family);
      },
    };
    if (url.protocol === 'https:' && !net.isIP(host)) reqOptions.servername = host;

    let req;
    const remaining = deadlineAt - Date.now();
    const deadlineTimer = setTimeout(() => {
      req?.destroy();
      finish(reject, new SafeFetchError('deadline_exceeded', 'The URL took too long to respond', 504));
    }, Math.max(0, remaining));
    const connectTimer = setTimeout(() => {
      req?.destroy();
      finish(reject, new SafeFetchError('connect_timeout', 'Timed out connecting to the URL', 504));
    }, Math.min(opts.connectTimeoutMs, Math.max(0, remaining)));

    try {
      req = requestImpl(reqOptions, (res) => {
        clearTimeout(connectTimer);
        const status = res.statusCode || 0;

        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          finish(resolve, { redirect: res.headers.location, status });
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          finish(reject, Object.assign(new SafeFetchError('upstream_status', `Failed to fetch URL (HTTP ${status})`, 502), { upstreamStatus: status }));
          return;
        }

        const contentType = res.headers['content-type'] || '';
        const mimeType = baseMimeType(contentType);
        if (!opts.allowedContentTypes.includes(mimeType)) {
          res.destroy();
          finish(reject, new SafeFetchError('unsupported_content_type', `Unsupported content type "${mimeType || 'unknown'}"`, 415));
          return;
        }
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > opts.maxBodyBytes) {
          res.destroy();
          finish(reject, new SafeFetchError('too_large', 'The response is larger than the allowed limit', 413));
          return;
        }

        const chunks = [];
        let total = 0;
        res.on('data', (chunk) => {
          total += chunk.length;
          if (total > opts.maxBodyBytes) {
            res.destroy();
            finish(reject, new SafeFetchError('too_large', 'The response is larger than the allowed limit', 413));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (settled) return;
          try {
            const body = decodeBody(Buffer.concat(chunks), res.headers['content-encoding'], opts.maxDecodedBytes);
            finish(resolve, { status, contentType, mimeType, body });
          } catch (e) {
            finish(reject, e);
          }
        });
        res.on('error', () => finish(reject, new SafeFetchError('network_error', 'The connection failed while reading the response', 502)));
      });
    } catch {
      finish(reject, new SafeFetchError('network_error', 'Could not start the request', 502));
      return;
    }

    req.on('error', (e) => finish(reject, e instanceof SafeFetchError ? e : new SafeFetchError('network_error', 'Could not connect to the URL', 502)));
    req.end();
  });
}

/**
 * @param {string} input  URL supplied by the caller
 * @param {object} [options]  overrides for SAFE_FETCH_DEFAULTS, plus
 *   `resolver(host) => Promise<{address, family}[]>` and
 *   `requestImpl(options, onResponse)` for tests.
 */
export async function safeFetch(input, options = {}) {
  const opts = { ...SAFE_FETCH_DEFAULTS, ...options };
  const resolver = opts.resolver || defaultResolver;
  const deadlineAt = Date.now() + opts.deadlineMs;

  let current = String(input);
  for (let hop = 0; ; hop++) {
    const target = validateUrl(current, opts);
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw new SafeFetchError('deadline_exceeded', 'The URL took too long to respond', 504);
    const pinned = await resolvePublicAddress(target.host, resolver, remaining);
    const res = await requestOnce(target, pinned, opts, deadlineAt);

    if (res.redirect) {
      if (hop >= opts.maxRedirects) throw new SafeFetchError('too_many_redirects', 'The URL redirected too many times', 502);
      try {
        current = new URL(res.redirect, target.url).href;
      } catch {
        throw new SafeFetchError('invalid_redirect', 'The URL redirected to an invalid location', 502);
      }
      continue;
    }
    return { ...res, finalUrl: target.url.href, redirects: hop, address: pinned.address };
  }
}
