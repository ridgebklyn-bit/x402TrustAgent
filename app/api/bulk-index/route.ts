import { NextRequest, NextResponse } from "next/server";
import { createX402Route, RouteError } from "../_lib/x402Route";
import { indexStore } from "../_lib/indexStore";
import { buildGoldIndex, IndexingLog } from "../../../lib/goldIndexEngine.js";

// Index up to 10 pasted documents in one paid call.
const handler = async (request: NextRequest): Promise<NextResponse> => {
  let body: { documents?: { filename?: string; text?: string }[] };
  try {
    body = await request.json();
  } catch {
    throw new RouteError('Request body must be JSON { "documents": [{ "filename": "...", "text": "..." }] }', 400);
  }

  const { documents } = body || {};
  if (!Array.isArray(documents) || documents.length === 0) {
    throw new RouteError("Provide a non-empty documents array", 400);
  }
  if (documents.length > 10) {
    throw new RouteError("Max 10 documents per bulk-index call", 400);
  }

  const results = [];
  for (const doc of documents) {
    if (!doc.text || doc.text.length < 50) {
      throw new RouteError(`Document "${doc.filename || "unnamed"}" is too short (minimum 50 characters)`, 400);
    }
    const log = new IndexingLog();
    const result = await buildGoldIndex(doc.text, doc.filename || "document.txt", log);
    const id = crypto.randomUUID();
    indexStore.set(id, { id, rawText: doc.text, ...result });
    results.push({ id, filename: doc.filename || "document.txt", nodeCount: result.goldMeta.nodeCount, hash: result.goldMeta.hash });
  }

  return NextResponse.json({ indexed: results.length, results });
};

export const POST = createX402Route({
  handler,
  resource: "/api/bulk-index",
  description: "Index up to 10 pasted documents in a single paid call.",
  price: "$0.20",
  serviceName: "Gold Source Indexing Agent",
  tags: ["indexing", "documents", "bulk", "rag-alternative"],
  discovery: {
    input: { documents: [{ filename: "a.txt", text: "..." }, { filename: "b.txt", text: "..." }] },
    inputSchema: {
      properties: {
        documents: {
          type: "array",
          description: "Up to 10 documents, each { filename, text }",
        },
      },
    },
    output: {
      example: { indexed: 2, results: [{ id: "...", filename: "a.txt", nodeCount: 5, hash: "..." }] },
    },
  },
});
