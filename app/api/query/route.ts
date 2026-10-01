import { NextRequest, NextResponse } from "next/server";
import { createX402Route, RouteError } from "../_lib/x402Route";
import { indexStore } from "../_lib/indexStore";
import { queryIndex } from "../../../lib/goldIndexEngine.js";

// Query a previously built index with O(1) inverted-index lookup - no
// vector search. NOTE: because of the in-memory store's serverless
// limitation (see _lib/indexStore.ts), always pass the indexId you got back
// from /api/index or /api/index-url rather than relying on "most recent".
const handler = async (request: NextRequest): Promise<NextResponse> => {
  let body: { indexId?: string; query?: string; text?: string };
  try {
    body = await request.json();
  } catch {
    throw new RouteError('Request body must be JSON { "indexId": "...", "query": "..." }', 400);
  }

  const q = body.query || body.text;
  if (!q) {
    throw new RouteError('Provide "query"', 400);
  }

  let indexData;
  if (body.indexId) {
    indexData = indexStore.get(body.indexId);
    if (!indexData) {
      throw new RouteError(
        "Index not found for that indexId on this server instance. Index a document first with /api/index, then query using the id it returns in the same request flow.",
        404,
      );
    }
  } else {
    const latest = Array.from(indexStore.values()).pop();
    if (!latest) {
      throw new RouteError("No indexes yet on this server instance. Index a document first with /api/index.", 400);
    }
    indexData = latest;
  }

  const results = queryIndex(indexData, q);

  return NextResponse.json({
    query: q,
    indexId: indexData.id,
    results,
    reasoning: `Searched inverted index for terms: ${q.toLowerCase().split(/\s+/).join(", ")}. Found ${results.length} nodes with O(1) lookup, no vector search needed. Each result includes a goldPointer to the immutable source.`,
    goldSourceVerified: true,
  });
};

export const POST = createX402Route({
  handler,
  resource: "/api/query",
  description:
    "Query a previously built gold-source index with O(1) inverted-index lookup - returns matching nodes with their verifiable gold pointers, no vector search.",
  price: "$0.01",
  serviceName: "Gold Source Indexing Agent",
  tags: ["indexing", "search", "rag-alternative"],
  discovery: {
    input: { indexId: "b6e2...", query: "termination clause" },
    inputSchema: {
      properties: {
        indexId: { type: "string", description: "The id returned by /api/index or /api/index-url" },
        query: { type: "string", description: "Search terms" },
      },
    },
    output: {
      example: { query: "termination", indexId: "b6e2...", results: [], goldSourceVerified: true },
    },
  },
});
