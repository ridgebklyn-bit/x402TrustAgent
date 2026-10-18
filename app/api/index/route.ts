import { NextRequest, NextResponse } from "next/server";
import { createX402Route, RouteError } from "../_lib/x402Route";
import { indexStore } from "../_lib/indexStore";
import { buildGoldIndex, IndexingLog } from "../../../lib/goldIndexEngine.js";
import { extractTextFromBuffer } from "../../../lib/fileExtractors.js";
import { SafeFetchError } from "../../../lib/safeFetch.js";

const MAX_CANONICAL_CHARS = 1_000_000;

// Core: index a document. Accepts either multipart/form-data with a "file"
// field (PDF, DOCX, or plain text), or JSON { text, filename } for pasted
// text. Real x402 payment required - see createX402Route below.
const handler = async (request: NextRequest): Promise<NextResponse> => {
  const contentType = request.headers.get("content-type") || "";
  let rawText = "";
  let filename = "pasted-text.txt";
  // Canonical text: pasted text exactly as received, or the text extracted
  // from an uploaded file. Uploads get it echoed back, since the caller
  // cannot otherwise reproduce the extraction to check spans.
  let source: Record<string, unknown> = { type: "text", canonicalization: "verbatim-input" };

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("file");
    if (file && typeof file !== "string") {
      const buf = Buffer.from(await file.arrayBuffer());
      let extracted: { text: string; kind: string; pdfPages?: number };
      try {
        extracted = await extractTextFromBuffer(buf, file.name);
      } catch (e: any) {
        if (e instanceof SafeFetchError) throw new RouteError(e.message, e.status);
        throw new RouteError("The file could not be read", 422);
      }
      rawText = extracted.text;
      filename = file.name;
      source = {
        type: "file",
        fileKind: extracted.kind,
        canonicalization: extracted.kind === "text" ? "utf8-decoded-file" : `${extracted.kind}-text`,
        ...(extracted.pdfPages !== undefined ? { pdfPages: extracted.pdfPages } : {}),
        canonicalText: rawText,
      };
    } else {
      const text = form.get("text");
      if (typeof text === "string") rawText = text;
      const fn = form.get("filename");
      if (typeof fn === "string" && fn) filename = fn;
    }
  } else {
    let body: { text?: string; filename?: string };
    try {
      body = await request.json();
    } catch {
      throw new RouteError(
        'Request body must be JSON { "text": "..." } or multipart/form-data with a "file" field',
        400,
      );
    }
    if (body.text !== undefined && typeof body.text !== "string") {
      throw new RouteError('"text" must be a string', 400);
    }
    rawText = body.text || "";
    filename = body.filename || filename;
  }

  if (!rawText || rawText.length < 50) {
    throw new RouteError("Document text is too short (minimum 50 characters)", 400);
  }
  if (rawText.length > MAX_CANONICAL_CHARS) {
    throw new RouteError(`Document text is too long (limit ${MAX_CANONICAL_CHARS} characters)`, 413);
  }

  const log = new IndexingLog();
  const result = await buildGoldIndex(rawText, filename, log);

  const id = crypto.randomUUID();
  indexStore.set(id, { id, rawText, ...result });

  return NextResponse.json({
    id,
    goldMeta: result.goldMeta,
    source,
    tree: result.tree,
    invertedIndexSize: Object.keys(result.invertedIndex).length,
    xrefs: result.xrefs.length,
    log: result.log,
    message: "Gold source indexed. Canonical text preserved, every node span round-trips against it.",
  });
};

export const POST = createX402Route({
  handler,
  resource: "/api/index",
  description:
    "Index a document (pasted text or an uploaded PDF/DOCX/TXT file) into a verifiable, hierarchical gold-source index - the text is never rewritten: every section and block carries an exact [start, end) span (UTF-16 code units) into the canonical text and a SHA-256 digest of that span.",
  price: "$0.05",
  serviceName: "Gold Source Indexing Agent",
  tags: ["indexing", "documents", "rag-alternative", "legal", "financial", "compliance"],
  discovery: {
    input: { text: "MASTER SERVICES AGREEMENT\n\nARTICLE 1 - DEFINITIONS\n..." },
    inputSchema: {
      properties: {
        text: { type: "string", description: "Document text to index (paste option)" },
        file: { type: "string", format: "binary", description: "PDF, DOCX, or TXT file to upload instead of pasting text (multipart/form-data)" },
        filename: { type: "string", description: "Optional label for the document" },
      },
    },
    output: {
      example: {
        id: "b6e2...",
        goldMeta: { filename: "document.txt", hash: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", hashAlgorithm: "sha256", charLength: 4200, offsetUnit: "utf16-code-unit", indexVersion: "gold-index-v2", nodeCount: 18 },
        tree: { id: "root", type: "DOCUMENT_ROOT", children: [] },
        message: "Gold source indexed. Original preserved, tree built, log audited.",
      },
    },
  },
});
