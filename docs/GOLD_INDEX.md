# Gold Source Indexing — gold-index-v2

Shared engine for AgentX402Pay (`POST /api/gold-index`) and the X402 Trust Agent (`/api/index`, `/api/index-url`, `/api/bulk-index`, `/api/query`, `/api/gold`). The trust agent also returns `source.canonicalText` for uploaded files, since the caller cannot reproduce the PDF/DOCX extraction, and `/api/gold` now recomputes both digests instead of reporting a fixed `hashMatches: true`.

## Request (unchanged)

JSON body with exactly one of:

- `text` — the document as a string, 50 to 1,000,000 characters.
- `url` — an `http://` or `https://` link to an HTML page, plain-text file or PDF.

Optional `filename` labels the document. Price and payment terms are unchanged.

## Canonical text and coordinates

Every offset and digest refers to the **canonical text**:

| Input | Canonical text | Returned? |
|---|---|---|
| `text` | The submitted string exactly as received | No (the caller already has it) |
| `url` | Text extracted by `url-text-v2` (see `lib/urlTextExtractor.js`) | Yes, as `source.canonicalText` |

- Offsets are **UTF-16 code units** (JavaScript string indices), not bytes. "é" is 1 unit; "🚀" is 2.
- Spans are **half-open**: `canonicalText.slice(start, end)` is the node's complete text.
- PDF offsets are positions in the extracted text. Page numbers are not preserved.

## Digests

SHA-256 (`node:crypto`), lowercase hex, over the **UTF-8 bytes** of:

- `goldMeta.hash` / `tree.goldHash`: the whole canonical text.
- `goldPointer.fullTextHash`: `canonicalText.slice(start, end)` for that node.

A digest lets you check that text is unchanged relative to a copy you already trust. It does not prove the document is authentic, that its statements are true, or that its source is trustworthy.

## Response changes from v1

Breaking:

- `goldMeta.hash`, `tree.goldHash` and `goldPointer.fullTextHash` are now 64-character SHA-256 hex digests (were 32-bit checksums of about 8 characters). Stored v1 hashes will not match.
- Section `title` is the full heading line ("ARTICLE 1 - DEFINITIONS"; v1 returned "- DEFINITIONS"). Markdown headings still drop their `#` marks.
- Content blocks are split differently: every run of text between two headings is one block, whatever its length. v1 merged and silently dropped sections of 5 lines or fewer, so node counts, ids and block boundaries differ.
- The `INIT` log entry no longer includes a `preview` of the document.

Additive:

- `goldMeta`: `hashAlgorithm`, `hashInput`, `offsetUnit`, `spanConvention`, `indexVersion`, `coverage`.
- `source`: input type, canonicalisation version, and for URLs the final URL, redirects, content type, PDF page counts and `canonicalText`.
- Every node: `sectionPath` (list of ancestor section titles).
- `goldPointer`: `excerptLength`, `excerptTruncated`; headings now also carry `fullTextHash` and `lineRange`.
- Entities: absolute `start`/`end` spans (block-relative `index` kept).

`excerpt` remains a preview (first 300 characters of a block, 200 of a heading). Check `excerptTruncated` before treating it as the whole passage.

## URL fetching (`lib/safeFetch.js`)

- `http`/`https` only, no credentials in the URL, ports 80 and 443 only.
- Every resolved address must be public; a mixed public/private DNS answer fails. Loopback, private, link-local, CGNAT, multicast, reserved, documentation and cloud-metadata ranges are blocked, as are IPv4-mapped, NAT64, 6to4 and Teredo IPv6 forms.
- The socket is pinned to the validated address; Host header, SNI and certificate checks still use the hostname.
- Redirects re-validated per hop, at most 3.
- 5 s connect timeout, 15 s overall deadline, 5 MB raw body, 10 MB decompressed, content types limited to HTML, XHTML, plain text and PDF. PDFs: first 50 pages, 10 s parse limit.

## Tests

```
npm test
```
