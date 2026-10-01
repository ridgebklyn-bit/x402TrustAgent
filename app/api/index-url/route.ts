import { NextRequest, NextResponse } from "next/server";
import { createX402Route, RouteError } from "../_lib/x402Route";
import { indexStore } from "../_lib/indexStore";
import { buildGoldIndex, IndexingLog } from "../../../lib/goldIndexEngine.js";
import { extractTextFromUrl } from "../../../lib/fileExtractors.js";

// Fetch and index content from a web page URL - useful where a simple
// copy-paste won't grab everything (JS-rendered pages, very long docs, etc.)
const handler = async (request: NextRequest): Promise<NextResponse> => {
  let body: { url?: string; filename?: string };
  try {
    body = await request.json();
  } catch {
    throw new RouteError('Request body must be JSON { "url": "..." }', 400);
  }

  const { url, filename } = body || {};
  if (!url) {
    throw new RouteError('Provide a "url"', 400);
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new RouteError(`"${url}" is not a valid URL`, 400);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new RouteError("Only http:// and https:// URLs are supported", 400);
  }

  const log = new IndexingLog();
  log.log("FETCH_URL", `Fetching and extracting readable text from ${url}.`, { url });

  let extracted: { text: string; meta: Record<string, unknown> };
  try {
    extracted = await extractTextFromUrl(url);
  } catch (e: any) {
    throw new RouteError(`Could not fetch that URL: ${e?.message || "unknown error"}`, 502);
  }

  if (!extracted.text || extracted.text.length < 50) {
    const meta = extracted.meta || {};
    const reason = meta.likelyBotBlocked
      ? "That page appears to have returned a bot-protection / \"verify you're human\" page instead of its real content."
      : "The page returned very little readable text after stripping scripts, nav, and ads - it may need JavaScript to render.";
    throw new RouteError(`Could not extract enough readable text from that URL. ${reason}`, 422);
  }

  const rawText = extracted.text;
  const resolvedFilename = filename || parsed.hostname + parsed.pathname;
  log.log("EXTRACT_COMPLETE", "Extracted readable text from page.", {}, { charLength: rawText.length });

  const result = await buildGoldIndex(rawText, resolvedFilename, log);

  const id = crypto.randomUUID();
  indexStore.set(id, { id, rawText, ...result });

  return NextResponse.json({
    id,
    goldMeta: result.goldMeta,
    tree: result.tree,
    invertedIndexSize: Object.keys(result.invertedIndex).length,
    xrefs: result.xrefs.length,
    log: result.log,
    message: "Gold source indexed from URL.",
  });
};

export const POST = createX402Route({
  handler,
  resource: "/api/index-url",
  description:
    "Fetch a web page or PDF link and index it into a verifiable, hierarchical gold-source index - the original text is never rewritten, only pointed to with byte-offset + hash proofs.",
  price: "$0.07",
  serviceName: "Gold Source Indexing Agent",
  tags: ["indexing", "documents", "rag-alternative", "legal", "financial", "compliance"],
  discovery: {
    input: { url: "https://example.com/contract.html" },
    inputSchema: {
      properties: {
        url: { type: "string", description: "URL of a web page or PDF to fetch and index" },
        filename: { type: "string", description: "Optional label for the document" },
      },
    },
    output: {
      example: {
        id: "b6e2...",
        goldMeta: { filename: "example.com/contract.html", hash: "1a2b3c", charLength: 4200, nodeCount: 18 },
        message: "Gold source indexed from URL.",
      },
    },
  },
});
