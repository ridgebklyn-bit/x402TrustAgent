/**
 * Bounded PDF text extraction.
 *
 * pdf-parse runs inside a worker thread. If it does not finish within the
 * time limit, the worker is terminated, which stops the parsing itself
 * (unlike a Promise.race, which only stops waiting for it).
 *
 * Memory is NOT hard-capped. The worker sets V8 resourceLimits, but testing
 * showed V8 can thrash near the limit without stopping, or the process can
 * exceed it before V8 reacts. The real bounds are the time limit here, the
 * 5 MB response cap in safeFetch and the page cap.
 *
 * pdf-parse is loaded from "pdf-parse/lib/pdf-parse.js" (not the package
 * index, whose debug mode tries to read a test file when it has no parent
 * module). The path is resolved in the main thread and handed to the
 * worker, so the worker needs no bundling of its own; next.config lists
 * pdf-parse in serverExternalPackages and outputFileTracingIncludes so the
 * file ships with the function.
 */

import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';

export const MAX_PDF_PAGES = 50;
export const PDF_PARSE_TIMEOUT_MS = 10000;
export const PDF_WORKER_MAX_HEAP_MB = 256;

export class PdfExtractError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'PdfExtractError';
    this.code = code;
    this.status = status;
  }
}

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const parse = require(workerData.modulePath);
const fn = typeof parse === 'function' ? parse : parse.default;
Promise.resolve()
  .then(() => fn(Buffer.from(workerData.bytes), { max: workerData.maxPages }))
  .then(
    (d) => parentPort.postMessage({ ok: true, text: String(d.text || ''), numpages: d.numpages || 0 }),
    (e) => parentPort.postMessage({ ok: false, message: String((e && e.message) || e) }),
  );
`;

let resolvedPdfParsePath;
function defaultModulePath() {
  if (!resolvedPdfParsePath) {
    const require = createRequire(import.meta.url);
    resolvedPdfParsePath = require.resolve('pdf-parse/lib/pdf-parse.js');
  }
  return resolvedPdfParsePath;
}

/**
 * @param {Buffer|Uint8Array} body  PDF bytes
 * @param {object} [opts]  timeoutMs, maxPages, maxHeapMb, and modulePath
 *   (absolute path of a CommonJS module exporting parse(buffer, options);
 *   tests use this to substitute a fake parser)
 * @returns {Promise<{text: string, numpages: number}>}
 */
export function extractPdfText(body, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? PDF_PARSE_TIMEOUT_MS;
  const maxPages = opts.maxPages ?? MAX_PDF_PAGES;
  const maxHeapMb = opts.maxHeapMb ?? PDF_WORKER_MAX_HEAP_MB;

  let modulePath;
  try {
    modulePath = opts.modulePath || defaultModulePath();
  } catch {
    return Promise.reject(new PdfExtractError('pdf_unavailable', 'PDF support is not available on this server', 500));
  }

  const bytes = new Uint8Array(body); // copy, then transfer the copy
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { modulePath, bytes, maxPages },
      transferList: [bytes.buffer],
      resourceLimits: { maxOldGenerationSizeMb: maxHeapMb, maxYoungGenerationSizeMb: 32 },
    });

    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Always tear the thread down, whatever the outcome.
      worker.terminate().catch(() => {}).finally(() => fn(value));
    };

    const timer = setTimeout(() => {
      done(reject, new PdfExtractError('pdf_timeout', 'The PDF took too long to parse', 504));
    }, timeoutMs);

    worker.once('message', (msg) => {
      if (msg && msg.ok) done(resolve, { text: msg.text, numpages: msg.numpages });
      else done(reject, new PdfExtractError('pdf_parse_failed', 'The PDF could not be read', 422));
    });
    worker.once('error', (err) => {
      const oom = err && (err.code === 'ERR_WORKER_OUT_OF_MEMORY' || /out of memory/i.test(String(err.message)));
      done(reject, oom
        ? new PdfExtractError('pdf_too_complex', 'The PDF needed too much memory to parse', 422)
        : new PdfExtractError('pdf_parse_failed', 'The PDF could not be read', 422));
    });
    worker.once('exit', (code) => {
      if (!settled) done(reject, new PdfExtractError('pdf_parse_failed', `The PDF parser stopped unexpectedly (exit ${code})`, 422));
    });
  });
}
