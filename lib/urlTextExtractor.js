/**
 * Fetches a URL through safeFetch (SSRF-hardened, size- and time-limited)
 * and extracts its readable text. That extracted text is the "canonical
 * text" for URL inputs: every offset and digest the index returns refers to
 * it, so the route returns it to the caller.
 *
 * Canonicalisation (version "url-text-v2"):
 *   - HTML / XHTML: body decoded as UTF-8; script, style, nav, footer,
 *     header, noscript, svg, iframe, form and aside removed; text taken from
 *     <article>, else <main>, else <body> (first with >200 characters);
 *     runs of spaces/tabs collapsed to one space, 3+ newlines collapsed to
 *     two, then trimmed.
 *   - text/plain: decoded as UTF-8, unchanged.
 *   - PDF: text from pdf-parse (first MAX_PDF_PAGES pages), unchanged,
 *     parsed in a worker thread that is terminated at the time limit (see
 *     lib/pdfExtract.js). Page numbers are not preserved, so offsets are
 *     positions in the extracted text only, not PDF page coordinates.
 *
 * Requires "cheerio" and "pdf-parse" - see package.json.
 */

import * as cheerio from 'cheerio';
import { safeFetch, SafeFetchError } from './safeFetch.js';
import { extractPdfText, PdfExtractError, MAX_PDF_PAGES } from './pdfExtract.js';

export const CANONICALIZATION_VERSION = 'url-text-v2';

const BOT_BLOCK_SIGNALS = [
  'verify you are human', 'verify you’re a human', 'checking your browser',
  'just a moment', 'access denied', 'are you a robot', 'captcha',
  'enable javascript and cookies', 'unusual traffic', 'blocked by network security'
];

// Errors surface as SafeFetchError so the route has a single error type
// carrying a code and HTTP status.
async function parsePdf(body, pdfOptions) {
  try {
    return await extractPdfText(body, pdfOptions);
  } catch (e) {
    if (e instanceof PdfExtractError) throw new SafeFetchError(e.code, e.message, e.status);
    throw new SafeFetchError('pdf_parse_failed', 'The PDF could not be read', 422);
  }
}

/**
 * @param {string} url
 * @param {object} [fetchOptions]  passed to safeFetch
 * @param {object} [pdfOptions]  passed to extractPdfText
 */
export async function extractTextFromUrl(url, fetchOptions = {}, pdfOptions = {}) {
  const res = await safeFetch(url, fetchOptions);
  const baseMeta = {
    httpStatus: res.status,
    contentType: res.contentType,
    finalUrl: res.finalUrl,
    redirects: res.redirects,
    bodyBytes: res.body.length,
    canonicalization: CANONICALIZATION_VERSION,
  };

  if (res.mimeType === 'application/pdf') {
    const data = await parsePdf(res.body, pdfOptions);
    return {
      text: data.text,
      meta: { ...baseMeta, source: 'pdf', extractedFrom: 'pdf-text', pdfPages: data.numpages, pdfPagesParsed: Math.min(data.numpages || 0, pdfOptions.maxPages ?? MAX_PDF_PAGES) },
    };
  }

  if (res.mimeType === 'text/plain') {
    const text = res.body.toString('utf8');
    return { text, meta: { ...baseMeta, source: 'text', extractedFrom: 'text-plain' } };
  }

  const html = res.body.toString('utf8');
  const $ = cheerio.load(html);
  $('script, style, nav, footer, header, noscript, svg, iframe, form, aside').remove();

  let text = '';
  let extractedFrom = 'body';
  if ($('article').text().trim().length > 200) {
    text = $('article').text(); extractedFrom = 'article';
  } else if ($('main').text().trim().length > 200) {
    text = $('main').text(); extractedFrom = 'main';
  } else {
    text = $('body').text(); extractedFrom = 'body';
  }

  text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const lowerSample = text.toLowerCase().slice(0, 2000);
  const likelyBotBlocked = BOT_BLOCK_SIGNALS.some(sig => lowerSample.includes(sig));

  return {
    text,
    meta: { ...baseMeta, source: 'html', extractedFrom, rawHtmlLength: html.length, extractedTextLength: text.length, likelyBotBlocked },
  };
}
