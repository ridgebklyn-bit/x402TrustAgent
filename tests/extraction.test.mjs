// Run: node --test tests/*.test.mjs   (needs `npm install`: cheerio, pdf-parse)
// End-to-end extraction through safeFetch with a mocked network, using the
// real cheerio and pdf-parse packages, then indexing the canonical text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import zlib from 'node:zlib';
import { extractTextFromUrl } from '../lib/urlTextExtractor.js';
import { buildGoldIndex, sha256Hex } from '../lib/goldIndexEngine.js';

const PUBLIC_V4 = '93.184.215.14';
const resolver = async () => [{ address: PUBLIC_V4, family: 4 }];

function transport(routes) {
  return (options, onResponse) => {
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = () => {
      const spec = routes[options.path];
      if (!spec) { req.emit('error', new Error('no route')); return; }
      const res = new PassThrough();
      res.statusCode = spec.status ?? 200;
      res.headers = spec.headers;
      setImmediate(() => { onResponse(res); res.end(spec.body); });
    };
    return req;
  };
}

// Builds a valid multi-page PDF (one Helvetica text line per page) with a
// correct xref table, so pdf-parse reads it without repair heuristics.
function makePdf(pages) {
  const objs = [];
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ');
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  const fontObj = 3 + pages.length * 2;
  pages.forEach((line, i) => {
    const contentObj = 4 + i * 2;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObj} 0 R >> >> /Contents ${contentObj} 0 R >>`);
    const stream = `BT /F1 18 Tf 72 720 Td (${line}) Tj ET`;
    objs.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  });
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const ARTICLE_HTML = `<!doctype html><html><head><title>t</title><style>.x{}</style><script>var secret=1</script></head>
<body><nav>Home | About</nav><header>Site header</header>
<article><h1>ARTICLE 1 - SCOPE</h1>
<p>This policy covers every contractor engaged by the company for any reason at all.</p>
<h2>ARTICLE 2 - PAYMENT</h2>
<p>Invoices are paid within thirty days of receipt, net of any agreed withholding amounts.</p></article>
<footer>Copyright</footer></body></html>`;

test('HTML: article text is extracted, chrome and scripts removed, spans round-trip', async () => {
  const r = await extractTextFromUrl('https://docs.example/policy', {
    resolver, requestImpl: transport({ '/policy': { headers: { 'content-type': 'text/html; charset=utf-8' }, body: ARTICLE_HTML } }),
  });
  assert.equal(r.meta.source, 'html');
  assert.equal(r.meta.extractedFrom, 'article');
  assert.equal(r.meta.canonicalization, 'url-text-v2');
  for (const gone of ['var secret', 'Home | About', 'Site header', 'Copyright']) assert.ok(!r.text.includes(gone), gone);
  assert.ok(r.text.includes('ARTICLE 1 - SCOPE'));
  assert.ok(r.text.includes('net of any agreed withholding amounts.'));

  const idx = await buildGoldIndex(r.text, 'policy');
  assert.equal(idx.goldMeta.coverage.complete, true);
  assert.equal(idx.goldMeta.hash, sha256Hex(r.text));
  (function walk(n) {
    if (n.goldPointer) assert.equal(sha256Hex(r.text.slice(n.goldPointer.start, n.goldPointer.end)), n.goldPointer.fullTextHash);
    (n.children || []).forEach(walk);
  })(idx.tree);
});

test('HTML: falls back to <main>, then <body>; flags bot-check pages', async () => {
  const long = 'Substantive paragraph text. '.repeat(10);
  const routes = {
    '/main': { headers: { 'content-type': 'text/html' }, body: `<body><div>side</div><main>${long}</main></body>` },
    '/body': { headers: { 'content-type': 'text/html' }, body: `<body><div>${long}</div></body>` },
    '/bot': { headers: { 'content-type': 'text/html' }, body: '<body>Just a moment... Checking your browser before accessing.</body>' },
  };
  const opts = { resolver, requestImpl: transport(routes) };
  assert.equal((await extractTextFromUrl('https://x.example/main', opts)).meta.extractedFrom, 'main');
  assert.equal((await extractTextFromUrl('https://x.example/body', opts)).meta.extractedFrom, 'body');
  assert.equal((await extractTextFromUrl('https://x.example/bot', opts)).meta.likelyBotBlocked, true);
});

test('HTML: gzip-encoded page and UTF-8 characters survive', async () => {
  const html = '<body><article>' + 'Café “naïve” résumé — 🚀 launch notes. '.repeat(8) + '</article></body>';
  const r = await extractTextFromUrl('https://x.example/gz', {
    resolver, requestImpl: transport({ '/gz': { headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' }, body: zlib.gzipSync(Buffer.from(html)) } }),
  });
  assert.ok(r.text.includes('Café “naïve” résumé — 🚀'));
});

test('text/plain is returned unchanged', async () => {
  const body = 'Line one\r\n\r\n\r\n\r\nLine   two\twith tab';
  const r = await extractTextFromUrl('https://x.example/t.txt', {
    resolver, requestImpl: transport({ '/t.txt': { headers: { 'content-type': 'text/plain; charset=utf-8' }, body } }),
  });
  assert.equal(r.text, body);
});

test('PDF: real pdf-parse extracts text in a worker and honours the page cap', async () => {
  const pdf = makePdf(['ARTICLE 1 - SCOPE', 'ARTICLE 2 - PAYMENT', 'ARTICLE 3 - TERM']);
  const requestImpl = transport({ '/a.pdf': { headers: { 'content-type': 'application/pdf' }, body: pdf } });
  const all = await extractTextFromUrl('https://files.example/a.pdf', { resolver, requestImpl });
  assert.equal(all.meta.source, 'pdf');
  assert.equal(all.meta.pdfPages, 3);
  for (const s of ['ARTICLE 1 - SCOPE', 'ARTICLE 2 - PAYMENT', 'ARTICLE 3 - TERM']) assert.ok(all.text.includes(s), s);

  const capped = await extractTextFromUrl('https://files.example/a.pdf', { resolver, requestImpl }, { maxPages: 2 });
  assert.ok(capped.text.includes('ARTICLE 2 - PAYMENT'));
  assert.ok(!capped.text.includes('ARTICLE 3 - TERM'), 'page cap not applied');
  assert.equal(capped.meta.pdfPagesParsed, 2);

  const idx = await buildGoldIndex(all.text, 'a.pdf');
  assert.equal(idx.goldMeta.coverage.complete, true);
});

test('PDF: corrupt bytes fail with a clean error', async () => {
  const requestImpl = transport({ '/bad.pdf': { headers: { 'content-type': 'application/pdf' }, body: Buffer.from('%PDF-1.4 this is not really a pdf') } });
  await assert.rejects(extractTextFromUrl('https://files.example/bad.pdf', { resolver, requestImpl }),
    (e) => e.code === 'pdf_parse_failed' && e.status === 422);
});

test('PDF: the real parser is stopped at the time limit', async () => {
  // A large many-page PDF with a near-zero time limit: the worker must be
  // terminated and the call must reject promptly.
  const pdf = makePdf(Array.from({ length: 400 }, (_, i) => `Page ${i + 1} text`));
  const requestImpl = transport({ '/big.pdf': { headers: { 'content-type': 'application/pdf' }, body: pdf } });
  const t0 = Date.now();
  await assert.rejects(extractTextFromUrl('https://files.example/big.pdf', { resolver, requestImpl }, { timeoutMs: 1, maxPages: 400 }),
    (e) => e.code === 'pdf_timeout' && e.status === 504);
  assert.ok(Date.now() - t0 < 3000);
});
