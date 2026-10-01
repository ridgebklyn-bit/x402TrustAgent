import { NextRequest, NextResponse } from "next/server";
import { createX402Route, RouteError } from "../_lib/x402Route";
import { indexStore } from "../_lib/indexStore";
import { buildGoldIndex, IndexingLog } from "../../../lib/goldIndexEngine.js";
import { extractTextFromBuffer } from "../../../lib/fileExtractors.js";

// Core: index a document. Accepts either multipart/form-data with a "file"
// field (PDF, DOCX, or plain text), or JSON { text, filename } for pasted
// text. Real x402 payment required - see createX402Route below.
const handler = async (request: NextRequest): Promise<NextResponse> => {
  const contentType = request.headers.get("content-type") || "";
  let rawText = "";
  let filename = "pasted-text.txt";

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("file");
    if (file && typeof file !== "string") {
      const buf = Buffer.from(await file.arrayBuffer());
      rawText = await extractTextFromBuffer(buf, file.name);
      filename = file.name;
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
    rawText = body.text || "";
    filename = body.filename || filename;
  }

  if (!rawText || rawText.length < 50) {
    throw new RouteError("Document text is too short (minimum 50 characters)", 400);
  }

  const log = new IndexingLog();
  const result = await buildGoldIndex(rawText, filename, log);

  const id = crypto.randomUUID();
  indexStore.set(id, { id, rawText, ...result });

  return NextResponse.json({
    id,
    goldMeta: result.goldMeta,
    tree: result.tree,
    invertedIndexSize: Object.keys(result.invertedIndex).length,
    xrefs: result.xrefs.length,
    log: result.log,
    message: "Gold source indexed. Original preserved, tree built, log audited.",
  });
};

export const POST = createX402Route({
  handler,
  resource: "/api/index",
  description:
    "Index a document (pasted text or an uploaded PDF/DOCX/TXT file) into a verifiable, hierarchical gold-source index - the original text is never rewritten, only pointed to with byte-offset + hash proofs.",
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
        goldMeta: { filename: "document.txt", hash: "1a2b3c", charLength: 4200, nodeCount: 18 },
        tree: { id: "root", type: "DOCUMENT_ROOT", children: [] },
        message: "Gold source indexed. Original preserved, tree built, log audited.",
      },
    },
  },
});
