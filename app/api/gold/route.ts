import { NextRequest, NextResponse } from "next/server";
import { createX402Route, RouteError, requireParam } from "../_lib/x402Route";
import { indexStore } from "../_lib/indexStore";
import { sha256Hex } from "../../../lib/goldIndexEngine.js";

function findNode(node: any, targetId: string): any {
  if (node.id === targetId) return node;
  for (const child of node.children || []) {
    const found = findNode(child, targetId);
    if (found) return found;
  }
  return null;
}

// Retrieve the exact text of one node from the stored canonical text and
// re-check it against the node's SHA-256 digest and the document digest.
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
  const excerptHash = sha256Hex(goldText);
  const documentHash = sha256Hex(data.rawText);
  const hashMatches = excerptHash === node.goldPointer.fullTextHash && documentHash === data.goldMeta.hash;

  return NextResponse.json({
    nodeId: node.id,
    title: node.title,
    sectionPath: node.sectionPath,
    goldPointer: node.goldPointer,
    goldSourceExcerpt: goldText,
    verification: {
      hashMatches,
      hashAlgorithm: "sha256",
      offsetUnit: "utf16-code-unit",
      charRange: [node.goldPointer.start, node.goldPointer.end],
      excerptHash,
      goldDocumentHash: documentHash,
      message: hashMatches
        ? "The excerpt is the exact text at this span of the stored canonical text, and both digests match."
        : "Digest mismatch: the stored text no longer matches the index.",
    },
  });
};

export const GET = createX402Route({
  handler,
  resource: "/api/gold",
  description:
    "Retrieve the exact text of one index node from the stored canonical text, re-checked against its SHA-256 digest.",
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
