// In-memory store for built indexes, keyed by id.
//
// IMPORTANT LIMITATION: Vercel's serverless platform can route separate
// requests to different function instances with no shared memory. An index
// built by one request to /api/index may not be visible to a later /api/query
// or /api/gold request if it lands on a different instance. This is a
// carry-over limitation from the original demo (which had the same in-memory
// Map) - not a regression, but not production-durable either.
//
// For reliable persistence across requests, replace this with Redis or a
// real database (see AgentX402Pay's lib/redis-channel-storage.ts for a
// pattern already used elsewhere in this family of projects).

export type StoredIndex = {
  id: string;
  rawText: string;
  tree: any;
  invertedIndex: Record<string, any>;
  xrefs: any[];
  goldMeta: any;
  log: any[];
};

const store = new Map<string, StoredIndex>();
export const indexStore = store;
