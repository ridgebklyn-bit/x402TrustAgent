/**
 * File & URL text extraction
 * Turns various input sources (plain text files, PDFs, Word docs, web pages)
 * into clean plain text that the indexing engine can work with.
 */

import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import * as cheerio from 'cheerio';

/**
 * Extract plain text from an uploaded file's raw bytes, based on its
 * filename extension.
 */
export async function extractTextFromBuffer(buffer, filename = '') {
  const ext = (filename.split('.').pop() || '').toLowerCase();

  if (ext === 'pdf') {
    const data = await pdfParse(buffer);
    return data.text;
  }

  if (ext === 'docx') {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  // .txt, .md, .json, .csv, .html (as raw source), or anything unrecognized:
  // treat as plain text.
  return buffer.toString('utf-8');
}

// Phrases commonly seen on bot-detection / "verify you're human" interstitial
// pages (Cloudflare, Akamai, PerimeterX, generic WAFs). If a fetched page's
// visible text is dominated by these, the site almost certainly blocked our
// server-side request rather than serving real content.
const BOT_BLOCK_SIGNALS = [
  'verify you are human',
  'verify you’re a human',
  'checking your browser',
  'just a moment',
  'access denied',
  'are you a robot',
  'captcha',
  'enable javascript and cookies',
  'request could not be satisfied',
  'reference id',
  'perimeterx',
  'unusual traffic',
  'blocked by network security'
];

/**
 * Fetch a URL server-side and extract its main readable text.
 * Handles both regular web pages (HTML) and direct links to PDFs.
 * Returns { text, meta } where meta carries diagnostic info useful when
 * text comes back empty or suspiciously short (site blocked the request,
 * needs JavaScript, etc.) instead of failing silently.
 */
export async function extractTextFromUrl(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  });

  const contentType = res.headers.get('content-type') || '';

  if (!res.ok) {
    const bodyPreview = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 300);
    const err = new Error(`Failed to fetch URL (HTTP ${res.status} ${res.statusText})`);
    err.meta = { httpStatus: res.status, contentType, bodyPreview };
    throw err;
  }

  // Direct link to a PDF file
  if (contentType.includes('application/pdf')) {
    const buf = Buffer.from(await res.arrayBuffer());
    const data = await pdfParse(buf);
    return { text: data.text, meta: { httpStatus: res.status, contentType, source: 'pdf' } };
  }

  const html = await res.text();
  const $ = cheerio.load(html);

  // Strip elements that are never useful as document content
  $('script, style, nav, footer, header, noscript, svg, iframe, form, aside').remove();

  // Prefer <article> or <main> if the page provides one - usually the
  // actual content, without nav/sidebar/footer clutter. Fall back to the
  // full body if that comes back too thin (some sites wrap real content
  // in neither tag).
  let text = '';
  let extractedFrom = 'body';
  if ($('article').text().trim().length > 200) {
    text = $('article').text();
    extractedFrom = 'article';
  } else if ($('main').text().trim().length > 200) {
    text = $('main').text();
    extractedFrom = 'main';
  } else {
    text = $('body').text();
    extractedFrom = 'body';
  }

  text = text
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const lowerSample = text.toLowerCase().slice(0, 2000);
  const likelyBlocked = BOT_BLOCK_SIGNALS.some(sig => lowerSample.includes(sig));

  return {
    text,
    meta: {
      httpStatus: res.status,
      contentType,
      extractedFrom,
      rawHtmlLength: html.length,
      extractedTextLength: text.length,
      likelyBotBlocked: likelyBlocked,
      textPreview: text.slice(0, 300)
    }
  };
}
