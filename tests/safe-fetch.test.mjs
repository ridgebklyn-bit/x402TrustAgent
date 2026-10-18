// Run: node --test tests/
// All network behaviour is mocked: a fake resolver stands in for DNS and a
// fake requestImpl stands in for http(s).request. Nothing here opens a
// socket to an internal or external host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import zlib from 'node:zlib';
import { safeFetch, isPublicAddress, validateUrl, SafeFetchError } from '../lib/safeFetch.js';

const PUBLIC_V4 = '93.184.215.14';
const PUBLIC_V6 = '2606:2800:21f:cb07:6820:80da:af6b:8b2c';

function fakeResolver(table) {
  const calls = [];
  const fn = async (host) => {
    calls.push(host);
    const v = table[host];
    if (typeof v === 'function') return v(calls.filter(h => h === host).length);
    if (!v) throw new Error('ENOTFOUND');
    return v.map(a => ({ address: a, family: a.includes(':') ? 6 : 4 }));
  };
  fn.calls = calls;
  return fn;
}

// routes: key "host/path" -> { status, headers, body, chunks, hang }
function fakeRequest(routes) {
  const seen = [];
  const impl = (options, onResponse) => {
    const req = new EventEmitter();
    req.destroyed = false;
    req.destroy = () => { req.destroyed = true; };
    req.end = () => {
      // Record where the socket would actually connect, via the pinned lookup.
      options.lookup(options.hostname, {}, (err, address) => {
        seen.push({ host: options.hostname, path: options.path, connectAddress: address, servername: options.servername, headers: options.headers });
        const spec = routes[`${options.hostname}${options.path}`];
        if (!spec) { req.emit('error', new Error('no route')); return; }
        if (spec.hang) return; // never responds
        const res = new PassThrough();
        res.statusCode = spec.status ?? 200;
        res.headers = spec.headers ?? { 'content-type': 'text/html' };
        setImmediate(() => {
          onResponse(res);
          if (spec.trickle) { res.write(Buffer.from('x')); return; } // starts, then stalls
          const chunks = spec.chunks ?? [spec.body ?? ''];
          for (const c of chunks) res.write(Buffer.isBuffer(c) ? c : Buffer.from(c));
          res.end();
        });
      });
    };
    return req;
  };
  impl.seen = seen;
  return impl;
}

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (e) => {
    assert.ok(e instanceof SafeFetchError, `expected SafeFetchError, got ${e}`);
    assert.equal(e.code, code);
    return true;
  });
}

test('address classification', () => {
  for (const ip of [PUBLIC_V4, '8.8.8.8', '1.1.1.1', PUBLIC_V6, '2001:4860:4860::8888']) assert.equal(isPublicAddress(ip), true, ip);
  for (const ip of [
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.100.100.200',
    '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1', '192.0.2.1', '240.0.0.1',
    '::1', '::', '::ffff:7f00:1', '::ffff:127.0.0.1', '::ffff:8.8.8.8', '64:ff9b::7f00:1',
    'fc00::1', 'fd00:ec2::254', 'fe80::1', 'fe80::1%eth0', 'ff02::1', '2001:db8::1', '2002:7f00:1::1',
    '2001:0:4136:e378:8000:63bf:3fff:fdd2', 'not-an-ip',
  ]) assert.equal(isPublicAddress(ip), false, ip);
});

test('malformed and prohibited URLs are rejected before any network activity', async () => {
  const resolver = fakeResolver({});
  const requestImpl = fakeRequest({});
  const cases = [
    ['not a url', 'invalid_url'],
    ['ftp://example.com/file', 'unsupported_protocol'],
    ['file:///etc/passwd', 'unsupported_protocol'],
    ['javascript:alert(1)', 'unsupported_protocol'],
    ['http://user:pass@example.com/', 'credentials_in_url'],
    ['http://example.com:22/', 'port_not_allowed'],
    ['https://example.com:8443/', 'port_not_allowed'],
    ['http://127.0.0.1/', 'destination_not_allowed'],
    ['http://2130706433/', 'destination_not_allowed'],
    ['http://0x7f000001/', 'destination_not_allowed'],
    ['http://0177.0.0.1/', 'destination_not_allowed'],
    ['http://127.1/', 'destination_not_allowed'],
    ['http://169.254.169.254/latest/meta-data/', 'destination_not_allowed'],
    ['http://[::1]/', 'destination_not_allowed'],
    ['http://[::ffff:127.0.0.1]/', 'destination_not_allowed'],
    ['http://[::ffff:7f00:1]/', 'destination_not_allowed'],
    ['http://[64:ff9b::a00:1]/', 'destination_not_allowed'],
    ['http://[fd00:ec2::254]/', 'destination_not_allowed'],
    ['http://[fe80::1]/', 'destination_not_allowed'],
  ];
  for (const [url, code] of cases) await rejectsWith(safeFetch(url, { resolver, requestImpl }), code);
  assert.equal(requestImpl.seen.length, 0, 'no request should have been attempted');
});

test('hostname resolving to a private address is rejected', async () => {
  const resolver = fakeResolver({ 'internal.example': ['10.0.0.5'], 'localhost': ['127.0.0.1', '::1'] });
  const requestImpl = fakeRequest({});
  await rejectsWith(safeFetch('http://internal.example/', { resolver, requestImpl }), 'destination_not_allowed');
  await rejectsWith(safeFetch('http://localhost/', { resolver, requestImpl }), 'destination_not_allowed');
  assert.equal(requestImpl.seen.length, 0);
});

test('mixed public/private DNS answers are rejected, not filtered', async () => {
  const resolver = fakeResolver({ 'mixed.example': [PUBLIC_V4, '192.168.0.10'], 'mixed6.example': [PUBLIC_V6, 'fd12::1'] });
  const requestImpl = fakeRequest({});
  await rejectsWith(safeFetch('https://mixed.example/', { resolver, requestImpl }), 'destination_not_allowed');
  await rejectsWith(safeFetch('https://mixed6.example/', { resolver, requestImpl }), 'destination_not_allowed');
  assert.equal(requestImpl.seen.length, 0);
});

test('valid public HTML is fetched and the socket is pinned to the validated address', async () => {
  const resolver = fakeResolver({ 'docs.example': [PUBLIC_V4] });
  const requestImpl = fakeRequest({ 'docs.example/page?x=1': { headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<html><body>Hello</body></html>' } });
  const res = await safeFetch('https://docs.example/page?x=1', { resolver, requestImpl });
  assert.equal(res.status, 200);
  assert.equal(res.mimeType, 'text/html');
  assert.equal(res.body.toString(), '<html><body>Hello</body></html>');
  assert.equal(res.address, PUBLIC_V4);
  assert.equal(requestImpl.seen[0].connectAddress, PUBLIC_V4);
  assert.equal(requestImpl.seen[0].host, 'docs.example', 'Host header / SNI keeps the hostname');
  assert.equal(requestImpl.seen[0].servername, 'docs.example');
});

test('valid public PDF bytes are returned unchanged', async () => {
  const pdf = Buffer.from('%PDF-1.4\n...binary...');
  const resolver = fakeResolver({ 'files.example': [PUBLIC_V6] });
  const requestImpl = fakeRequest({ 'files.example/a.pdf': { headers: { 'content-type': 'application/pdf' }, body: pdf } });
  const res = await safeFetch('https://files.example/a.pdf', { resolver, requestImpl });
  assert.equal(res.mimeType, 'application/pdf');
  assert.deepEqual(res.body, pdf);
  assert.equal(requestImpl.seen[0].connectAddress, PUBLIC_V6);
});

test('DNS rebinding: one resolution per hop, connection uses that answer', async () => {
  // First lookup returns a public address, any later lookup a private one.
  const resolver = fakeResolver({ 'rebind.example': (n) => [{ address: n === 1 ? PUBLIC_V4 : '127.0.0.1', family: 4 }] });
  const requestImpl = fakeRequest({ 'rebind.example/': { headers: { 'content-type': 'text/plain' }, body: 'ok' } });
  const res = await safeFetch('http://rebind.example/', { resolver, requestImpl });
  assert.equal(res.body.toString(), 'ok');
  assert.equal(resolver.calls.length, 1);
  assert.equal(requestImpl.seen[0].connectAddress, PUBLIC_V4);
});

test('redirects: each hop is re-validated; redirect to a private address fails', async () => {
  const resolver = fakeResolver({ 'a.example': [PUBLIC_V4], 'b.example': [PUBLIC_V4], 'evil.example': ['10.0.0.1'] });
  const requestImpl = fakeRequest({
    'a.example/start': { status: 302, headers: { location: 'https://b.example/next' } },
    'b.example/next': { status: 301, headers: { location: '/final' } },
    'b.example/final': { headers: { 'content-type': 'text/plain' }, body: 'done' },
    'a.example/to-private-ip': { status: 302, headers: { location: 'http://10.0.0.1/' } },
    'a.example/to-private-host': { status: 307, headers: { location: 'http://evil.example/' } },
    'a.example/to-metadata': { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } },
    'a.example/to-file': { status: 302, headers: { location: 'file:///etc/passwd' } },
  });
  const ok = await safeFetch('https://a.example/start', { resolver, requestImpl });
  assert.equal(ok.body.toString(), 'done');
  assert.equal(ok.redirects, 2);
  assert.equal(ok.finalUrl, 'https://b.example/final');
  await rejectsWith(safeFetch('https://a.example/to-private-ip', { resolver, requestImpl }), 'destination_not_allowed');
  await rejectsWith(safeFetch('https://a.example/to-private-host', { resolver, requestImpl }), 'destination_not_allowed');
  await rejectsWith(safeFetch('https://a.example/to-metadata', { resolver, requestImpl }), 'destination_not_allowed');
  await rejectsWith(safeFetch('https://a.example/to-file', { resolver, requestImpl }), 'unsupported_protocol');
});

test('redirect loops stop at the hop limit', async () => {
  const resolver = fakeResolver({ 'loop.example': [PUBLIC_V4] });
  const requestImpl = fakeRequest({ 'loop.example/': { status: 302, headers: { location: '/' } } });
  await rejectsWith(safeFetch('http://loop.example/', { resolver, requestImpl }), 'too_many_redirects');
  assert.equal(requestImpl.seen.length, 4); // first request + 3 redirects
});

test('slow responses hit the deadline', async () => {
  const resolver = fakeResolver({ 'slow.example': [PUBLIC_V4] });
  const requestImpl = fakeRequest({ 'slow.example/': { hang: true }, 'slow.example/trickle': { trickle: true, headers: { 'content-type': 'text/html' } } });
  await rejectsWith(safeFetch('http://slow.example/', { resolver, requestImpl, connectTimeoutMs: 50, deadlineMs: 1000 }), 'connect_timeout');
  await rejectsWith(safeFetch('http://slow.example/trickle', { resolver, requestImpl, deadlineMs: 100 }), 'deadline_exceeded');
});

test('slow DNS hits the deadline', async () => {
  const resolver = () => new Promise(() => {});
  await rejectsWith(safeFetch('http://dns-hang.example/', { resolver, requestImpl: fakeRequest({}), deadlineMs: 50 }), 'deadline_exceeded');
});

test('oversized bodies are rejected (declared and streamed)', async () => {
  const resolver = fakeResolver({ 'big.example': [PUBLIC_V4] });
  const requestImpl = fakeRequest({
    'big.example/declared': { headers: { 'content-type': 'text/html', 'content-length': String(10 * 1024 * 1024) }, body: '' },
    'big.example/streamed': { headers: { 'content-type': 'text/html' }, chunks: Array.from({ length: 20 }, () => Buffer.alloc(1024, 97)) },
  });
  await rejectsWith(safeFetch('http://big.example/declared', { resolver, requestImpl }), 'too_large');
  await rejectsWith(safeFetch('http://big.example/streamed', { resolver, requestImpl, maxBodyBytes: 10 * 1024 }), 'too_large');
});

test('decompression bombs are rejected; normal gzip is decoded', async () => {
  const bomb = zlib.gzipSync(Buffer.alloc(20 * 1024 * 1024, 0));
  const small = zlib.gzipSync(Buffer.from('<p>compressed page</p>'));
  const resolver = fakeResolver({ 'gz.example': [PUBLIC_V4] });
  const requestImpl = fakeRequest({
    'gz.example/bomb': { headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' }, body: bomb },
    'gz.example/ok': { headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' }, body: small },
    'gz.example/weird': { headers: { 'content-type': 'text/html', 'content-encoding': 'compress' }, body: 'x' },
  });
  assert.ok(bomb.length < 5 * 1024 * 1024, 'bomb passes the raw-size check');
  await rejectsWith(safeFetch('http://gz.example/bomb', { resolver, requestImpl }), 'decoded_too_large');
  const ok = await safeFetch('http://gz.example/ok', { resolver, requestImpl });
  assert.equal(ok.body.toString(), '<p>compressed page</p>');
  await rejectsWith(safeFetch('http://gz.example/weird', { resolver, requestImpl }), 'unsupported_encoding');
});

test('disallowed content types and upstream errors fail safely', async () => {
  const resolver = fakeResolver({ 'ct.example': [PUBLIC_V4] });
  const requestImpl = fakeRequest({
    'ct.example/bin': { headers: { 'content-type': 'application/octet-stream' }, body: 'x' },
    'ct.example/none': { headers: {}, body: 'x' },
    'ct.example/404': { status: 404, headers: { 'content-type': 'text/html' }, body: 'nope' },
  });
  await rejectsWith(safeFetch('http://ct.example/bin', { resolver, requestImpl }), 'unsupported_content_type');
  await rejectsWith(safeFetch('http://ct.example/none', { resolver, requestImpl }), 'unsupported_content_type');
  await rejectsWith(safeFetch('http://ct.example/404', { resolver, requestImpl }), 'upstream_status');
});

test('validateUrl strips IPv6 brackets and applies default ports', () => {
  assert.equal(validateUrl('https://[2606:4700::1111]/').host, '2606:4700::1111');
  assert.equal(validateUrl('https://example.com/').port, 443);
  assert.equal(validateUrl('http://example.com/').port, 80);
});

test('real node:http honours the pinned lookup instead of DNS', async () => {
  // Proves the pinning mechanism itself with the real http module: the
  // hostname below does not exist in DNS, so the request can only reach the
  // test server if Node uses the supplied lookup. The server is a local
  // listener created by this test; the address check is bypassed here only
  // by calling http.request directly, never through safeFetch.
  const http = (await import('node:http')).default;
  const server = http.createServer((req, res) => { res.end(`host=${req.headers.host}`); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const body = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: 'pinned-host.invalid', port, path: '/', agent: false,
        lookup: (_h, opts, cb) => opts && opts.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4),
      }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
      req.on('error', reject);
      req.end();
    });
    assert.equal(body, `host=pinned-host.invalid:${port}`, 'Host header keeps the original hostname');
  } finally {
    server.close();
  }
});
