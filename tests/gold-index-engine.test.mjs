// Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildGoldIndex, sha256Hex } from '../lib/goldIndexEngine.js';

function allNodes(tree) {
  const out = [];
  (function walk(n) { if (n.goldPointer) out.push(n); (n.children || []).forEach(walk); })(tree);
  return out;
}

function assertSpansRoundTrip(text, result) {
  for (const n of allNodes(result.tree)) {
    const g = n.goldPointer;
    const slice = text.slice(g.start, g.end);
    assert.ok(g.start >= 0 && g.end <= text.length && g.start <= g.end, `bad span on ${n.id}`);
    assert.equal(g.fullTextHash, sha256Hex(slice), `hash mismatch on ${n.id}`);
    assert.equal(g.excerpt, slice.slice(0, g.excerpt.length), `excerpt not a prefix on ${n.id}`);
    assert.equal(g.excerptTruncated, slice.length > g.excerpt.length);
    if (n.content) {
      for (const e of n.content.entities) assert.equal(text.slice(e.start, e.end), e.value, `entity span on ${n.id}`);
    }
  }
  assert.equal(result.goldMeta.coverage.complete, true, 'non-whitespace text was dropped');
}

const CONTRACT = [
  'MASTER SERVICES AGREEMENT',
  '',
  'ARTICLE 1 - DEFINITIONS',
  '"Services" means the work in Exhibit A.',
  '"Fees" means $5,000 per month.',
  '',
  'ARTICLE 2 - PAYMENT',
  'Client shall pay Fees within 30 days.',
  'Late payments accrue 1.5% monthly interest.',
  '',
  'ARTICLE 3 - TERM',
  'This Agreement starts on January 1, 2026.',
  'Either party may terminate on 30 days notice.',
].join('\n');

test('all three sample contract articles survive with exact spans', async () => {
  const r = await buildGoldIndex(CONTRACT, 'msa.txt');
  assertSpansRoundTrip(CONTRACT, r);
  const blocks = allNodes(r.tree).filter(n => n.type === 'CONTENT_BLOCK');
  const texts = blocks.map(b => CONTRACT.slice(b.goldPointer.start, b.goldPointer.end));
  assert.deepEqual(texts, [
    '"Services" means the work in Exhibit A.\n"Fees" means $5,000 per month.',
    'Client shall pay Fees within 30 days.\nLate payments accrue 1.5% monthly interest.',
    'This Agreement starts on January 1, 2026.\nEither party may terminate on 30 days notice.',
  ]);
});

test('numbered headings keep their numbers and section paths are explicit', async () => {
  const r = await buildGoldIndex(CONTRACT, 'msa.txt');
  const sections = allNodes(r.tree).filter(n => n.type === 'SECTION').map(n => n.title);
  assert.deepEqual(sections, ['MASTER SERVICES AGREEMENT', 'ARTICLE 1 - DEFINITIONS', 'ARTICLE 2 - PAYMENT', 'ARTICLE 3 - TERM']);
  const payBlock = allNodes(r.tree).find(n => n.type === 'CONTENT_BLOCK' && n.title === 'Under: ARTICLE 2 - PAYMENT');
  assert.deepEqual(payBlock.sectionPath, ['ARTICLE 2 - PAYMENT']);
});

test('single-line sections and duplicate headings/passages get distinct correct spans', async () => {
  const doc = '# Notice\nSend notice by email.\n\n# Notice\nSend notice by email.\n';
  const r = await buildGoldIndex(doc, 'dup.txt');
  assertSpansRoundTrip(doc, r);
  const nodes = allNodes(r.tree);
  assert.deepEqual(nodes.map(n => [n.type, n.goldPointer.start, n.goldPointer.end]), [
    ['SECTION', 0, 8], ['CONTENT_BLOCK', 9, 30], ['SECTION', 32, 40], ['CONTENT_BLOCK', 41, 62],
  ]);
});

test('nested markdown headings build the right section paths', async () => {
  const doc = '# Policy\n## Scope\nApplies to staff.\n## Exceptions\nNone.\n# Appendix\nForms.';
  const r = await buildGoldIndex(doc, 'p.md');
  assertSpansRoundTrip(doc, r);
  const paths = allNodes(r.tree).filter(n => n.type === 'CONTENT_BLOCK').map(n => n.sectionPath.join(' > '));
  assert.deepEqual(paths, ['Policy > Scope', 'Policy > Exceptions', 'Appendix']);
});

test('accented text, curly quotes and emoji follow UTF-16 code-unit offsets', async () => {
  const doc = 'Café terms — “quoted” 🚀 text here.\n# Résumé\nNaïve coöperation 👍🏽 clause.';
  const r = await buildGoldIndex(doc, 'u.txt');
  assertSpansRoundTrip(doc, r);
  assert.equal(r.goldMeta.offsetUnit, 'utf16-code-unit');
  assert.equal(r.goldMeta.charLength, doc.length);
  const last = allNodes(r.tree).at(-1);
  assert.equal(last.goldPointer.end, doc.length);
  assert.equal(doc.slice(last.goldPointer.start, last.goldPointer.end), 'Naïve coöperation 👍🏽 clause.');
  // Byte length differs from the reported unit count, proving the offsets are not bytes.
  assert.notEqual(Buffer.byteLength(doc, 'utf8'), doc.length);
});

test('CRLF line endings keep exact spans', async () => {
  const doc = 'ARTICLE 1 - SCOPE\r\nLine one of the scope.\r\nLine two.\r\n\r\nARTICLE 2 - END\r\nDone.';
  const r = await buildGoldIndex(doc, 'crlf.txt');
  assertSpansRoundTrip(doc, r);
  assert.equal(allNodes(r.tree).length, 4);
});

test('long blocks are flagged as truncated previews', async () => {
  const doc = 'INTRODUCTION\n' + 'word '.repeat(200).trim();
  const r = await buildGoldIndex(doc, 'long.txt');
  const block = allNodes(r.tree).find(n => n.type === 'CONTENT_BLOCK');
  assert.equal(block.goldPointer.excerptTruncated, true);
  assert.equal(block.goldPointer.excerpt.length, 300);
  assert.ok(block.goldPointer.end - block.goldPointer.start > 300);
});

test('SHA-256 matches standard known-answer vectors', () => {
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'), '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  // Hashes the UTF-8 bytes ("é" = c3 a9), not UTF-16 code units (e9 00).
  const utf8 = createHash('sha256').update(Buffer.from([0xc3, 0xa9])).digest('hex');
  const utf16 = createHash('sha256').update(Buffer.from([0xe9, 0x00])).digest('hex');
  assert.equal(sha256Hex('é'), utf8);
  assert.notEqual(sha256Hex('é'), utf16);
});

test('identical content gives the same digest; one changed character changes it', async () => {
  const a = await buildGoldIndex(CONTRACT, 'a.txt');
  const b = await buildGoldIndex(CONTRACT, 'b.txt');
  const c = await buildGoldIndex(CONTRACT.replace('$5,000', '$5,001'), 'c.txt');
  assert.equal(a.goldMeta.hash, b.goldMeta.hash);
  assert.notEqual(a.goldMeta.hash, c.goldMeta.hash);
  assert.equal(a.goldMeta.hash, sha256Hex(CONTRACT));
  assert.equal(a.goldMeta.hashAlgorithm, 'sha256');
});

test('log does not carry document text', async () => {
  const secret = 'CONFIDENTIAL-PHRASE-XYZ appears only in the document body text here.';
  const r = await buildGoldIndex(secret, 's.txt');
  assert.ok(!JSON.stringify(r.log).includes('CONFIDENTIAL-PHRASE-XYZ'));
});

test('cross-references and query paths carry exact spans', async () => {
  const { queryIndex } = await import('../lib/goldIndexEngine.js');
  const doc = 'ARTICLE 1 - FEES\nFees are set out in Section 4.2 and Article 3.\n\nARTICLE 2 - LATE PAYMENT\nLate fees apply as described in Section 4.2.';
  const r = await buildGoldIndex(doc, 'x.txt');
  assert.ok(r.xrefs.length >= 3);
  for (const x of r.xrefs) assert.equal(doc.slice(x.start, x.end), x.ref);
  const hits = queryIndex(r, 'late fees');
  assert.ok(hits.length > 0);
  assert.equal(hits[0].path[0], 'x.txt');
  assert.ok(!JSON.stringify(r.log).includes('Section 4.2'), 'reference text leaked into the log');
});

// Heading styles seen in real extracted text (gold-index-v2.1).
test('numbered headings with or without a space after the dot become sections', async () => {
  const doc = [
    'A Short Paper Title',
    'Author Name',
    '',
    'Abstract. One sentence of abstract text that runs on for a while.',
    '1.Introduction',
    'Commerce relies on trusted third parties to process payments.',
    '1',
    '2.Transactions',
    'We define a coin as a chain of signatures.',
    'Block',
    'Hash',
    '2.1 Ownership',
    'Each owner transfers the coin by signing a hash.',
    '3. Timestamp Server',
    'The server takes a hash of a block of items.',
    'References',
    '[1] An earlier paper, 1998.',
  ].join('\n');
  const r = await buildGoldIndex(doc, 'paper.txt');
  assertSpansRoundTrip(doc, r);
  const sections = allNodes(r.tree).filter((n) => n.type === 'SECTION').map((n) => [n.title, n.sectionPath.join(' > ')]);
  assert.deepEqual(sections, [
    ['1.Introduction', '1.Introduction'],
    ['2.Transactions', '2.Transactions'],
    ['2.1 Ownership', '2.Transactions > 2.1 Ownership'],
    ['3. Timestamp Server', '3. Timestamp Server'],
    ['References', 'References'],
  ]);
  // Page numbers and figure labels stay in the body text.
  const intro = allNodes(r.tree).find((n) => n.title === 'Under: 1.Introduction');
  assert.ok(doc.slice(intro.goldPointer.start, intro.goldPointer.end).endsWith('\n1'));
});

test('long numbered sentences are body text, not headings', async () => {
  const doc = [
    '6. Guidance in the use of these Imperatives',
    'Imperatives must be used with care.',
    '1. MUST This word, or the terms "REQUIRED" or "SHALL", mean that the',
    ' definition is an absolute requirement of the specification.',
    '2. Late payments accrue interest at the rate set out in this agreement each month.',
    '3. Payment is due on receipt.',
    '1350 Mass. Ave.',
  ].join('\n');
  const r = await buildGoldIndex(doc, 'rfc.txt');
  assertSpansRoundTrip(doc, r);
  const sections = allNodes(r.tree).filter((n) => n.type === 'SECTION').map((n) => n.title);
  assert.deepEqual(sections, ['6. Guidance in the use of these Imperatives']);
  assert.equal(r.goldMeta.indexVersion, 'gold-index-v2.1');
});
