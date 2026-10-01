/**
 * Gold Source Indexing Engine
 * Philosophy: Agents understand INDEXES better than paragraphs.
 * We build a verifiable, hierarchical, traceable index where the original text
 * is the gold source - never rewritten, only pointed to.
 */

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

// Simple keyword extraction without external deps
function extractKeywords(text, topK = 8) {
  const stop = new Set(['the','and','for','are','with','this','that','from','they','have','been','will','which','would','there','their','what','about','also','into','more','when','than','them','some','other','only','such','these','those','then','than','just','over','under','while']);
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(w => w.length > 3 && !stop.has(w));
  const freq = {};
  words.forEach(w => freq[w] = (freq[w]||0)+1);
  return Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0,topK).map(([w,c])=>({term:w, freq:c}));
}

function extractEntities(text) {
  const entities = [];
  // Dates
  const dateRegex = /\b(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}|\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4})/g;
  // Money
  const moneyRegex = /\$[\d,]+(?:\.\d{2})?|\b\d+(?:,\d{3})*\s*(?:USD|USDC|dollars)\b/gi;
  // References like Section 3.2, Article IV, etc
  const refRegex = /\b(?:Section|Article|Clause|Paragraph|§)\s+[\dIVX\.]+/gi;
  // Definitions: "X means Y" or "X shall"
  const defRegex = /\b([A-Z][A-Za-z\s]{2,40}?)\s+(?:means|shall|is defined as)\b/g;

  let m;
  while ((m = dateRegex.exec(text)) !== null) entities.push({type:'DATE', value:m[0], index:m.index});
  while ((m = moneyRegex.exec(text)) !== null) entities.push({type:'MONEY', value:m[0], index:m.index});
  while ((m = refRegex.exec(text)) !== null) entities.push({type:'REFERENCE', value:m[0], index:m.index});
  while ((m = defRegex.exec(text)) !== null) entities.push({type:'DEFINITION', value:m[1].trim(), index:m.index});

  return entities.slice(0, 25);
}

function detectStructure(text) {
  const lines = text.split('\n');
  const nodes = [];
  let currentPos = 0;

  const headingPatterns = [
    { regex: /^#{1,6}\s+(.+)$/, level: (m) => m[0].match(/#/g).length },
    { regex: /^(?:ARTICLE|SECTION|CHAPTER|PART)\s+[IVX\d]+[.:]?\s*(.+)?$/i, level: () => 1 },
    { regex: /^\d+(?:\.\d+)*\s+[A-Z].+$/, level: (m) => m[0].split('.')[0].split(' ').length <=2 ? m[0].split('.').length : 2 },
    { regex: /^[A-Z][A-Z\s]{5,}$/, level: () => 2 }, // ALL CAPS HEADING
    { regex: /^\s*[a-z]\)\s+/, level: () => 4 },
  ];

  let buffer = [];
  let bufferStart = 0;
  let lastHeading = null;

  for (let i=0; i<lines.length; i++) {
    const line = lines[i];
    let isHeading = null;
    for (const pat of headingPatterns) {
      const match = line.match(pat.regex);
      if (match) {
        isHeading = { text: (match[1] || line).trim(), level: pat.level(match), raw: line, lineNum: i };
        break;
      }
    }

    if (isHeading && buffer.length > 5) {
      // flush buffer as paragraph node
      nodes.push({
        type: 'PARAGRAPH_BLOCK',
        raw: buffer.join('\n'),
        startLine: bufferStart,
        endLine: i-1,
        level: lastHeading ? lastHeading.level + 1 : 3,
        headingParent: lastHeading?.text || null
      });
      buffer = [];
      bufferStart = i;
    }

    if (isHeading) {
      nodes.push({
        type: 'HEADING',
        raw: isHeading.raw,
        title: isHeading.text,
        startLine: i,
        endLine: i,
        level: isHeading.level,
        lineNum: i
      });
      lastHeading = isHeading;
      bufferStart = i+1;
    } else {
      if (buffer.length === 0) bufferStart = i;
      buffer.push(line);
    }
  }
  if (buffer.length > 0) {
    nodes.push({
      type: 'PARAGRAPH_BLOCK',
      raw: buffer.join('\n'),
      startLine: bufferStart,
      endLine: lines.length-1,
      level: lastHeading ? lastHeading.level + 1 : 3,
      headingParent: lastHeading?.text || null
    });
  }

  return nodes;
}

export async function buildGoldIndex(rawText, filename = 'document.txt', log = new IndexingLog()) {
  log.log('INIT', 'Agent received complex document for gold-source indexing. Preserving original as immutable truth.', { filename, charLength: rawText.length, preview: rawText.slice(0,200) });

  // Step 1: Integrity Hash (gold source fingerprint)
  let hash = 0;
  for (let i=0;i<rawText.length;i++) hash = ((hash<<5)-hash)+rawText.charCodeAt(i);
  const goldHash = Math.abs(hash).toString(16);
  log.log('GOLD_HASH', 'Created SHA-like fingerprint of gold source. Original will never be mutated, only referenced.', { goldHash }, { verification: 'original_text_hash', length: rawText.length });

  // Step 2: Structure detection
  const t0 = Date.now();
  const structuralNodes = detectStructure(rawText);
  log.log('STRUCTURE_SCAN', 'Scanning for hierarchical structure using multi-pattern heading detection (Markdown, Legal, Academic, Technical). Agents navigate trees faster than linear paragraphs.', { patternsChecked: 5 }, { nodesDetected: structuralNodes.length, headings: structuralNodes.filter(n=>n.type==='HEADING').length, blocks: structuralNodes.filter(n=>n.type==='PARAGRAPH_BLOCK').length, durationMs: Date.now()-t0 });

  // Step 3: Build tree
  const tree = {
    id: 'root',
    type: 'DOCUMENT_ROOT',
    title: filename,
    goldHash,
    totalChars: rawText.length,
    children: [],
    metadata: {
      createdAt: new Date().toISOString(),
      indexingModel: 'gold-index-v1 (vectorless, reasoning-based)',
      principle: 'Original text is immutable gold source. Index only points.'
    }
  };

  let stack = [tree];
  let nodeCounter = 0;

  for (const sNode of structuralNodes) {
    if (sNode.type === 'HEADING') {
      const level = sNode.level;
      while (stack.length > level) stack.pop();
      const parent = stack[stack.length-1];
      const newNode = {
        id: `idx_${++nodeCounter}`,
        type: 'SECTION',
        title: sNode.title,
        level: level,
        charStart: rawText.indexOf(sNode.raw),
        charEnd: rawText.indexOf(sNode.raw) + sNode.raw.length,
        goldPointer: { start: rawText.indexOf(sNode.raw), end: rawText.indexOf(sNode.raw) + sNode.raw.length, excerpt: sNode.raw.slice(0,200) },
        children: [],
        keywords: [],
        entities: [],
        summary: null
      };
      parent.children.push(newNode);
      stack.push(newNode);
    } else {
      // Paragraph block
      const parent = stack[stack.length-1];
      const startIdx = rawText.indexOf(sNode.raw);
      if (startIdx === -1) continue;

      const keywords = extractKeywords(sNode.raw);
      const entities = extractEntities(sNode.raw);

      // Heuristic summary: first sentence + keyword density
      const sentences = sNode.raw.split(/[.!?]\s+/).filter(s=>s.trim().length>20);
      const summary = sentences[0] ? sentences[0].slice(0,220) + (sentences[0].length>220?'...':'') : sNode.raw.slice(0,150);

      const blockNode = {
        id: `idx_${++nodeCounter}`,
        type: 'CONTENT_BLOCK',
        title: sNode.headingParent ? `Under: ${sNode.headingParent}` : `Block ${nodeCounter}`,
        level: sNode.level,
        charStart: startIdx,
        charEnd: startIdx + sNode.raw.length,
        goldPointer: {
          start: startIdx,
          end: startIdx + sNode.raw.length,
          excerpt: sNode.raw.slice(0,300),
          fullTextHash: (()=>{let h=0; for(let i=0;i<sNode.raw.length;i++) h=((h<<5)-h)+sNode.raw.charCodeAt(i); return Math.abs(h).toString(16);})(),
          lineRange: [sNode.startLine, sNode.endLine]
        },
        content: {
          summary,
          keywords,
          entities,
          charLength: sNode.raw.length,
          sentenceCount: sentences.length
        },
        children: []
      };

      parent.children.push(blockNode);

      if (nodeCounter % 15 === 0) {
        log.log('INDEX_NODE_CREATED', `Indexed block ${nodeCounter}: extracted ${keywords.length} keywords, ${entities.length} entities. Maintaining gold pointer to original.`, { nodeId: blockNode.id, parent: parent.id }, { keywords: keywords.map(k=>k.term), entityTypes: [...new Set(entities.map(e=>e.type))] });
      }
    }
  }

  log.log('TREE_COMPLETE', 'Hierarchical tree index built. Depth-first navigable, fully traceable to gold source.', { totalNodes: nodeCounter, treeDepth: Math.max(...collectDepths(tree)), rootChildren: tree.children.length }, { structure: 'DOCUMENT_ROOT -> SECTION* -> CONTENT_BLOCK*' });

  // Step 4: Build inverted keyword index (for agent-fast lookup)
  const invertedIndex = {};
  function walk(node) {
    if (node.content?.keywords) {
      node.content.keywords.forEach(kw => {
        if (!invertedIndex[kw.term]) invertedIndex[kw.term] = [];
        invertedIndex[kw.term].push({ nodeId: node.id, freq: kw.freq, title: node.title });
      });
    }
    (node.children||[]).forEach(walk);
  }
  walk(tree);

  log.log('INVERTED_INDEX', 'Built inverted keyword index for O(1) agent lookups. Agents query index, not paragraphs.', { uniqueTerms: Object.keys(invertedIndex).length }, { topTerms: Object.entries(invertedIndex).sort((a,b)=>b[1].length-a[1].length).slice(0,10).map(([k,v])=>`${k}(${v.length})`) });

  // Step 5: Cross-reference map
  const xrefs = [];
  function collectRefs(node) {
    if (node.content?.entities) {
      node.content.entities.filter(e=>e.type==='REFERENCE').forEach(ref => {
        xrefs.push({ from: node.id, ref: ref.value, context: node.title });
      });
    }
    (node.children||[]).forEach(collectRefs);
  }
  collectRefs(tree);
  log.log('XREF_MAP', 'Mapped internal cross-references for navigational reasoning.', {}, { crossRefsFound: xrefs.length, examples: xrefs.slice(0,3) });

  return {
    tree,
    invertedIndex,
    xrefs,
    goldMeta: {
      filename,
      hash: goldHash,
      charLength: rawText.length,
      indexedAt: new Date().toISOString(),
      nodeCount: nodeCounter
    },
    log: log.getTrace()
  };
}

function collectDepths(node, depth=0) {
  if (!node.children || node.children.length===0) return [depth];
  return node.children.flatMap(c=>collectDepths(c, depth+1));
}

export function queryIndex(indexData, query) {
  const { tree, invertedIndex } = indexData;
  const queryTerms = query.toLowerCase().split(/\s+/).filter(w=>w.length>2);

  // Score nodes by term overlap
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

  // Collect matching nodes with their gold pointers
  const results = [];
  function findNodes(node) {
    if (scores[node.id]) {
      results.push({
        nodeId: node.id,
        title: node.title,
        score: scores[node.id],
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

function getPath(root, targetId, path=[]) {
  if (root.id === targetId) return [...path, root.title];
  for (const child of root.children||[]) {
    const res = getPath(child, targetId, [...path, root.title]);
    if (res) return res;
  }
  return null;
}
