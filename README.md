# X402 Trust Agent - Gold Source Indexing Agent

Verifiable, hierarchical document indexing, monetized over real x402 payments on Base/Solana mainnet through Coinbase's CDP Facilitator.

Turns a pasted document, an uploaded PDF/DOCX/TXT file, or a web page URL into a verifiable, hierarchical index. The original text is never rewritten - every index node carries a byte-offset "gold pointer" plus a hash back to the original, so excerpts can be verified byte-for-byte against the source.

Separated out of the AgentX402Pay project into its own repo/deployment/domain for a dedicated trust-focused brand (legal, financial, and compliance buyers), while still riding the same real x402 payment rail.

## Endpoints

- `POST /api/index` - $0.05 - index pasted text or an uploaded file (PDF/DOCX/TXT)
- `POST /api/index-url` - $0.07 - fetch and index a web page or PDF link
- `POST /api/query` - $0.01 - search a previously built index (pass the `indexId` you got back)
- `GET /api/gold?id=...&nodeId=...` - $0.02 - retrieve a verified excerpt from the gold source
- `POST /api/bulk-index` - $0.20 - index up to 10 pasted documents in one call

## Known limitation: index storage is in-memory

`app/api/_lib/indexStore.ts` is a plain in-memory `Map`. On Vercel's serverless platform, separate requests can land on different function instances with no shared memory - an index built by `/api/index` may not be visible to a later `/api/query` or `/api/gold` call if it hits a different instance. This mirrors the original demo's own limitation, not a new regression. For reliable persistence, swap it for Redis or a real database before relying on this in production at volume.

## Known limitation: the frontend demo UI

`public/index.html` is the original standalone app's UI, carried over as-is. Its "Demo bypass (free)" toggle called the old fake payment check with `?free=true` / `X-402-BYPASS` headers - neither is honored by the real x402-gated routes here, so the interactive demo buttons will return 402 Payment Required instead of working. Treat this page as a marketing/capability showcase for now; real buyers are expected to be AI agents calling the API directly with automatic payment, not humans clicking through the UI. A real wallet-connect-and-pay flow would be a separate follow-up project.

## Environment variables (set in Vercel)

Same wallets and credentials as the AgentX402Pay project, reused by design (same env var names):

- `X402_NETWORK` = `mainnet`
- `X402_EVM_ADDRESS`
- `X402_SVM_ADDRESS`
- `CDP_API_KEY_ID`
- `CDP_API_KEY_SECRET`
- `OFFER_RECEIPT_SIGNER_PRIVATE_KEY` (can reuse AgentX402Pay's value, or use a separate signing identity for this service)

## Local development

```bash
npm install
npm run dev
```

Runs against the free x402.org testnet facilitator by default (no env vars needed). Set `X402_NETWORK=mainnet` plus the vars above to test against real payments.
