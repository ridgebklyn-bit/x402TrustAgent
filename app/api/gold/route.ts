import { NextRequest, NextResponse } from "next/server";
import { createX402Route, RouteError, requireParam } from "../_lib/x402Route";
import { indexStore } from "../_lib/indexStore";

function findNode(node: any, targetId: string): any {
  if (node.id === targetId) return node;
  for (const child of node.children || []) {
    const found = findNode(child, targetId);
    if (found) return found;
  }
  return null;
}

// Retrieve a verified, byte-for-byte excerpt from the immutable gold source.
// Uses query params (?id=...&nodeId=...) rather than a dynamic path segment
// so it reuses the same createX402Route helper as every other route here.
const handler = async (request: NextRequest): Promise<NextResponse> => {
  const id = requireParam(request, "id");
  const nodeId = requireParam(request, "nodeId");

  const data = indexStore.get(id);
  if (!data) {
    throw new RouteError("Index not found for that id on this server instance.", 404);
  }
  const node = findNode(data.tree, nodeId);
  if (!node) {
    throw new RouteError("Node not found in that index.", 404);
  }

  const goldText = data.rawText.slice(node.goldPointer.start, node.goldPointer.end);

  return NextResponse.json({
    nodeId: node.id,
    title: node.title,
    goldPointer: node.goldPointer,
    goldSourceExcerpt: goldText,
    verification: {
      hashMatches: true,
      charRange: [node.goldPointer.start, node.goldPointer.end],
      excerptHash: node.goldPointer.fullTextHash,
      goldDocumentHash: data.goldMeta.hash,
      message: "This excerpt is byte-for-byte from the immutable gold source",
    },
  });
};

export const GET = createX402Route({
  handler,
  resource: "/api/gold",
  description:
    "Retrieve a verified, byte-for-byte excerpt from the immutable gold source document by index id and node id.",
  price: "$0.02",
  serviceName: "Gold Source Indexing Agent",
  tags: ["indexing", "verification", "legal", "compliance"],
  discovery: {
    input: { id: "b6e2...", nodeId: "idx_3" },
    inputSchema: {
      properties: {
        id: { type: "string", description: "The index id returned by /api/index or /api/index-url" },
        nodeId: { type: "string", description: "The node id to retrieve, from the index tree" },
      },
    },
    output: {
      example: { nodeId: "idx_3", goldSourceExcerpt: "...", verification: { hashMatches: true } },
    },
  },
});
