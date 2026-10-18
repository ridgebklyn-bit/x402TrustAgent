/**
 * Gold Source Indexing Engine (gold-index-v2)
 *
 * Builds a hierarchical index whose every node points back into an exact,
 * unmodified "canonical text". The index never rewrites the source; it only
 * records where each heading and content block sits in it.
 *
 * Coordinate system
 *   Offsets are UTF-16 code-unit indices into the canonical text (the same
 *   units JavaScript string indexing uses). They are NOT byte offsets: a
 *   character such as "é" is 1 unit, an emoji such as "🚀" is 2 units.
 *   Spans are half-open: `start` is inclusive, `end` is exclusive, so
 *   `canonicalText.slice(start, end)` returns the node's full text exactly.
 *   Spans always begin and end on line boundaries, never inside a surrogate
 *   pair.
 *
 * Hashing
 *   Every digest is SHA-256 (node:crypto) over the UTF-8 encoding of the
 *   exact characters hashed: the whole canonical text for the document
 *   digest, and `canonicalText.slice(start, end)` for each node digest.
 *   Output is lowercase hex. A digest lets a caller check that text is
 *   unchanged relative to a copy they already trust. It does not prove the
 *   document is authentic, that its statements are true, or that its source
 *   is trustworthy.
 *
 * Ported from the standalone Gold Source Indexing Agent (Express app).
 */

import { createHash } from 'node:crypto';

export const INDEX_VERSION = 'gold-index-v2.1';
export const OFFSET_UNIT = 'utf16-code-unit';
export const SPAN_CONVENTION = 'half-open [start, end): canonicalText.slice(start, end) is the full node text';
export const HASH_ALGORITHM = 'sha256';
export const HASH_INPUT = 'UTF-8 bytes of the hashed text (whole canonical text, or canonicalText.slice(start, end) per node); hex digest';

const HEADING_EXCERPT_CHARS = 200;
const BLOCK_EXCERPT_CHARS = 300;

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export class IndexingLog {
  constructor() {
    this.entries = [];
    this.startTime = Date.now();
  }

  log(step, reasoning, inputMeta = {}, outputMeta = {}, level = 'info') {
    const entry = {
      id: `log_${this.entries.length + 1}`,
      timestamp: new Date().toISOString(),
      elapsedMs: Date.now() - this.startTime,
      step,
      level,
      reasoning,
      input: inputMeta,
      output: outputMeta
    };
    this.entries.push(entry);
    return entry;
  }

  getTrace() {
    return this.entries;
  }
}

function extractKeywords(text, topK = 8) {
  const stop = new Set(['the','and','for','are','with','this','that','from','they','have','been','will','which','would','there','their','what','about','also','into','more','when','than','them','some','other','only','such','these','those','then','than','just','over','under','while']);
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(w => w.length > 3 && !stop.has(w));
  const freq = {};
  words.forEach(w => freq[w] = (freq[w]||0)+1);
  return Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0,topK).map(([w,c])=>({term:w, freq:c}));
}

// `index` stays relative to the block (unchanged from v1); `start`/`end` are
// absolute half-open spans into the canonical text.
function extractEntities(text, baseOffset) {
  const entities = [];
  const dateRegex = /\b(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}|\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4})/g;
  const moneyRegex = /\$[\d,]+(?:\.\d{2})?|\b\d+(?:,\d{3})*\s*(?:USD|USDC|dollars)\b/gi;
  const refRegex = /\b(?:Section|Article|Clause|Paragraph|§)\s+[\dIVX\.]+/gi;
  const defRegex = /\b([A-Z][A-Za-z\s]{2,40}?)\s+(?:means|shall|is defined as)\b/g;

  const push = (type, value, index) =>
    entities.push({ type, value, index, start: baseOffset + index, end: baseOffset + index + value.length });

  let m;
  while ((m = dateRegex.exec(text)) !== null) push('DATE', m[0], m.index);
  while ((m = moneyRegex.exec(text)) !== null) push('MONEY', m[0], m.index);
  while ((m = refRegex.exec(text)) !== null) push('REFERENCE', m[0], m.index);
  // m[1] starts at m.index (the group opens the match); trim() only removes
  // trailing whitespace, so the span still matches the value exactly.
  while ((m = defRegex.exec(text)) !== null) push('DEFINITION', m[1].trim(), m.index);

  return entities.slice(0, 25);
}

// Splits text into lines and records each line's half-open span. A trailing
// "\r" (CRLF files) is excluded from the line span but stays in the source.
function splitLines(text) {
  const lines = [];
  let pos = 0;
  for (;;) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? text.length : nl;
    let contentEnd = lineEnd;
    if (contentEnd > pos && text.charCodeAt(contentEnd - 1) === 13) contentEnd--;
    lines.push({ start: pos, end: contentEnd, text: text.slice(pos, contentEnd) });
    if (nl === -1) break;
    pos = nl + 1;
  }
  return lines;
}

const HEADING_PATTERNS = [
  { regex: /^#{1,6}\s+(.+)$/, level: (m) => m[0].match(/^#+/)[0].length, title: (m) => m[1].trim() },
  { regex: /^(?:ARTICLE|SECTION|CHAPTER|PART)\s+[IVX\d]+[.:]?\s*(.+)?$/i, level: () => 1 },
  // Numbered headings: "1 Scope", "1. Scope", "1.Scope" (common in PDF
  // text), "2.3 Fees", "2.3. Fees". Level = number of numeric parts. Long
  // numbered sentences (definitions, list items) are rejected by
  // isPlausibleHeadingTitle, so "1. MUST This word, or the terms ..." stays
  // body text.
  {
    regex: /^(\d{1,3}(?:\.\d{1,3})*)(?:\.\s*|\s+)([A-Z].*)$/,
    level: (m) => Math.min(m[1].split('.').length, 4),
    accept: (m) => isPlausibleHeadingTitle(m[2]),
  },
  // Common unnumbered section names, alone on their line.
  { regex: /^(?:abstract|introduction|background|overview|summary|scope|definitions|conclusions?|references|bibliography|acknowledge?ments|appendix(?:\s+[A-Z\d]{1,3})?)\s*:?$/i, level: () => 1 },
  { regex: /^[A-Z][A-Z\s]{5,}$/, level: () => 2 },
  { regex: /^\s*[a-z]\)\s+/, level: () => 4 },
];

// A numbered line is a heading only if it reads like a title: at most 80
// characters and 10 words, no comma or semicolon, and not ending like a
// sentence or clause.
const MAX_HEADING_TITLE_CHARS = 80;
const MAX_HEADING_TITLE_WORDS = 10;
function isPlausibleHeadingTitle(title) {
  const t = title.trim();
  if (t.length === 0 || t.length > MAX_HEADING_TITLE_CHARS) return false;
  if (t.split(/\s+/).length > MAX_HEADING_TITLE_WORDS) return false;
  if (/[,;]/.test(t)) return false;
  if (/[.!?:]$/.test(t) && !/^[A-Z\d][^.]*:$/.test(t)) return false;
  return true;
}

function matchHeading(lineText) {
  for (const pat of HEADING_PATTERNS) {
    const m = lineText.match(pat.regex);
    if (m && (!pat.accept || pat.accept(m))) {
      // v1 kept only the text after the number ("ARTICLE 1 - DEFINITIONS"
      // became "- DEFINITIONS"). v2 keeps the full heading line; Markdown
      // headings drop only their leading "#" marks.
      const title = pat.title ? pat.title(m) : lineText.trim();
      return { level: pat.level(m), title };
    }
  }
  return null;
}

/**
 * Single pass over the lines. Every heading line becomes a HEADING node and
 * every run of non-heading lines between headings becomes one
 * PARAGRAPH_BLOCK, whatever its length. Spans come from the line positions
 * recorded while parsing; there is no text search, so repeated passages keep
 * their own positions. Only blank lines at the edges of a run are left out.
 */
function detectStructure(text) {
  const lines = splitLines(text);
  const nodes = [];
  let run = [];
  let lastHeading = null;

  const flush = () => {
    let first = 0;
    let last = run.length - 1;
    while (first <= last && run[first].line.text.trim() === '') first++;
    while (last >= first && run[last].line.text.trim() === '') last--;
    if (first <= last) {
      const start = run[first].line.start;
      const end = run[last].line.end;
      nodes.push({
        type: 'PARAGRAPH_BLOCK',
        start,
        end,
        startLine: run[first].lineNum,
        endLine: run[last].lineNum,
        level: lastHeading ? lastHeading.level + 1 : 3,
        headingParent: lastHeading?.title || null
      });
    }
    run = [];
  };

  lines.forEach((line, lineNum) => {
    const heading = matchHeading(line.text);
    if (heading) {
      flush();
      nodes.push({
        type: 'HEADING',
        start: line.start,
        end: line.end,
        startLine: lineNum,
        endLine: lineNum,
        level: heading.level,
        title: heading.title
      });
      lastHeading = heading;
    } else {
      run.push({ line, lineNum });
    }
  });
  flush();

  return nodes;
}

function makePointer(rawText, sNode, excerptChars) {
  const text = rawText.slice(sNode.start, sNode.end);
  return {
    start: sNode.start,
    end: sNode.end,
    // A preview only: compare excerptLength with end - start (or check
    // excerptTruncated) before treating it as the whole passage.
    excerpt: text.slice(0, excerptChars),
    excerptLength: Math.min(text.length, excerptChars),
    excerptTruncated: text.length > excerptChars,
    fullTextHash: sha256Hex(text),
    lineRange: [sNode.startLine, sNode.endLine]
  };
}

function countNonWhitespace(text) {
  return text.replace(/\s+/g, '').length;
}

export async function buildGoldIndex(rawText, filename = 'document.txt', log = new IndexingLog()) {
  // Document content is deliberately not copied into the log.
  log.log('INIT', 'Received document for gold-source indexing. The canonical text is never modified, only referenced.', { filename, charLength: rawText.length, offsetUnit: OFFSET_UNIT });

  const goldHash = sha256Hex(rawText);
  log.log('GOLD_HASH', 'Computed SHA-256 digest of the canonical text.', { hashAlgorithm: HASH_ALGORITHM }, { goldHash, length: rawText.length });

  const t0 = Date.now();
  const structuralNodes = detectStructure(rawText);
  log.log('STRUCTURE_SCAN', 'Scanned lines for headings (Markdown, legal, numbered, all-caps, lettered) and grouped the text between them into blocks.', { patternsChecked: HEADING_PATTERNS.length }, { nodesDetected: structuralNodes.length, headings: structuralNodes.filter(n=>n.type==='HEADING').length, blocks: structuralNodes.filter(n=>n.type==='PARAGRAPH_BLOCK').length, durationMs: Date.now()-t0 });

  const tree = {
    id: 'root',
    type: 'DOCUMENT_ROOT',
    title: filename,
    goldHash,
    totalChars: rawText.length,
    level: 0,
    sectionPath: [],
    children: [],
    metadata: {
      createdAt: new Date().toISOString(),
      indexingModel: `${INDEX_VERSION} (vectorless, rule-based)`,
      principle: 'Canonical text is immutable. Index only points.'
    }
  };

  const stack = [tree];
  let nodeCounter = 0;
  let indexedNonWhitespace = 0;

  for (const sNode of structuralNodes) {
    if (sNode.type === 'HEADING') {
      // Pop to the nearest ancestor with a smaller level, so a heading never
      // nests under a deeper or equal one.
      while (stack.length > 1 && stack[stack.length - 1].level >= sNode.level) stack.pop();
      const parent = stack[stack.length - 1];
      const newNode = {
        id: `idx_${++nodeCounter}`,
        type: 'SECTION',
        title: sNode.title,
        level: sNode.level,
        sectionPath: [...parent.sectionPath, sNode.title],
        // charStart/charEnd duplicate goldPointer.start/end (kept for clients
        // of the standalone trust-agent API, which exposed them).
        charStart: sNode.start,
        charEnd: sNode.end,
        goldPointer: makePointer(rawText, sNode, HEADING_EXCERPT_CHARS),
        children: [],
        keywords: [],
        entities: [],
        summary: null
      };
      parent.children.push(newNode);
      stack.push(newNode);
    } else {
      const parent = stack[stack.length - 1];
      const raw = rawText.slice(sNode.start, sNode.end);

      const keywords = extractKeywords(raw);
      const entities = extractEntities(raw, sNode.start);
      const sentences = raw.split(/[.!?]\s+/).filter(s=>s.trim().length>20);
      const summary = sentences[0] ? sentences[0].slice(0,220) + (sentences[0].length>220?'...':'') : raw.slice(0,150);

      nodeCounter++;
      parent.children.push({
        id: `idx_${nodeCounter}`,
        type: 'CONTENT_BLOCK',
        title: sNode.headingParent ? `Under: ${sNode.headingParent}` : `Block ${nodeCounter}`,
        level: sNode.level,
        sectionPath: [...parent.sectionPath],
        charStart: sNode.start,
        charEnd: sNode.end,
        goldPointer: makePointer(rawText, sNode, BLOCK_EXCERPT_CHARS),
        content: { summary, keywords, entities, charLength: raw.length, sentenceCount: sentences.length },
        children: []
      });
    }
    indexedNonWhitespace += countNonWhitespace(rawText.slice(sNode.start, sNode.end));
  }

  const totalNonWhitespace = countNonWhitespace(rawText);
  const coverage = { indexedNonWhitespaceChars: indexedNonWhitespace, totalNonWhitespaceChars: totalNonWhitespace, complete: indexedNonWhitespace === totalNonWhitespace };
  log.log('TREE_COMPLETE', 'Built the hierarchical index; every node span round-trips against the canonical text.', { totalNodes: nodeCounter }, { structure: 'DOCUMENT_ROOT -> SECTION* -> CONTENT_BLOCK*', coverage }, coverage.complete ? 'info' : 'warn');

  const invertedIndex = {};
  (function walk(node) {
    if (node.content?.keywords) {
      node.content.keywords.forEach(kw => {
        if (!invertedIndex[kw.term]) invertedIndex[kw.term] = [];
        invertedIndex[kw.term].push({ nodeId: node.id, freq: kw.freq, title: node.title });
      });
    }
    (node.children||[]).forEach(walk);
  })(tree);

  log.log('INVERTED_INDEX', 'Built inverted keyword index.', { uniqueTerms: Object.keys(invertedIndex).length }, {});

  // Internal cross-references ("Section 3.2", "Article IV", ...). Only the
  // count is logged; the references themselves stay out of the log.
  const xrefs = [];
  (function collectRefs(node) {
    if (node.content?.entities) {
      node.content.entities.filter(e => e.type === 'REFERENCE').forEach(ref => {
        xrefs.push({ from: node.id, ref: ref.value, start: ref.start, end: ref.end, context: node.title });
      });
    }
    (node.children || []).forEach(collectRefs);
  })(tree);
  log.log('XREF_MAP', 'Mapped internal cross-references.', {}, { crossRefsFound: xrefs.length });

  return {
    tree,
    invertedIndex,
    xrefs,
    goldMeta: {
      filename,
      hash: goldHash,
      hashAlgorithm: HASH_ALGORITHM,
      hashInput: HASH_INPUT,
      charLength: rawText.length,
      offsetUnit: OFFSET_UNIT,
      spanConvention: SPAN_CONVENTION,
      indexVersion: INDEX_VERSION,
      indexedAt: new Date().toISOString(),
      nodeCount: nodeCounter,
      coverage
    },
    log: log.getTrace()
  };
}

export function queryIndex(indexData, query) {
  const { tree, invertedIndex } = indexData;
  const queryTerms = query.toLowerCase().split(/\s+/).filter(w=>w.length>2);

  const scores = {};
  queryTerms.forEach(term => {
    Object.keys(invertedIndex).forEach(idxTerm => {
      if (idxTerm.includes(term) || term.includes(idxTerm)) {
        invertedIndex[idxTerm].forEach(hit => {
          scores[hit.nodeId] = (scores[hit.nodeId]||0) + hit.freq * (idxTerm===term ? 2 : 1);
        });
      }
    });
  });

  const results = [];
  function findNodes(node) {
    if (scores[node.id]) {
      results.push({
        nodeId: node.id,
        title: node.title,
        score: scores[node.id],
        sectionPath: node.sectionPath,
        goldPointer: node.goldPointer,
        summary: node.content?.summary,
        keywords: node.content?.keywords,
        path: getPath(tree, node.id)
      });
    }
    (node.children||[]).forEach(findNodes);
  }
  findNodes(tree);

  return results.sort((a,b)=>b.score-a.score).slice(0,8);
}

// Titles from the root (document title) down to and including the node.
function getPath(root, targetId, path = []) {
  if (root.id === targetId) return [...path, root.title];
  for (const child of root.children || []) {
    const res = getPath(child, targetId, [...path, root.title]);
    if (res) return res;
  }
  return null;
}
