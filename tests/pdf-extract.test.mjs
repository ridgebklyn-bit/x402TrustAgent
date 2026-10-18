// Run: node --test tests/*.test.mjs
// Uses fake parser modules from tests/fixtures, so it needs no packages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPdfText, PdfExtractError } from '../lib/pdfExtract.js';

const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('timeout terminates the parsing thread, not just the wait', async () => {
  const hb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pdfhb-')), 'heartbeat');
  fs.writeFileSync(hb, '');
  process.env.HEARTBEAT_FILE = hb; // inherited by the worker's process.env
  const t0 = Date.now();
  await assert.rejects(
    extractPdfText(Buffer.from('%PDF'), { modulePath: fixture('hang-parser.cjs'), timeoutMs: 300 }),
    (e) => e instanceof PdfExtractError && e.code === 'pdf_timeout' && e.status === 504,
  );
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 2000, `rejected after ${elapsed} ms`);
  const sizeAtReject = fs.statSync(hb).size;
  assert.ok(sizeAtReject > 0, 'the fake parser did start running');
  await sleep(300);
  assert.equal(fs.statSync(hb).size, sizeAtReject, 'heartbeat kept growing: the parser thread is still running');
  delete process.env.HEARTBEAT_FILE;
});

test('successful parse returns text and passes the page cap', async () => {
  const r = await extractPdfText(Buffer.from('12345'), { modulePath: fixture('ok-parser.cjs'), maxPages: 7 });
  assert.deepEqual(r, { text: 'bytes=5 max=7', numpages: 3 });
});

test('missing parser module fails closed', async () => {
  await assert.rejects(
    extractPdfText(Buffer.from('%PDF'), { modulePath: '/nonexistent/parser.cjs' }),
    (e) => e instanceof PdfExtractError && e.code === 'pdf_parse_failed',
  );
});
