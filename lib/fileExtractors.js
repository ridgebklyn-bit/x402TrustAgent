/**
 * File & URL text extraction for the trust agent.
 *
 * - Uploaded files: PDF via the worker-thread parser (lib/pdfExtract.js,
 *   terminated at the time limit), DOCX via mammoth, anything else decoded
 *   as UTF-8 unchanged. The returned text is the canonical text the index
 *   points into.
 * - URLs: delegated to lib/urlTextExtractor.js, which fetches through the
 *   SSRF-hardened lib/safeFetch.js.
 */

import mammoth from 'mammoth';
import { extractPdfText, PdfExtractError } from './pdfExtract.js';
import { SafeFetchError } from './safeFetch.js';

export { extractTextFromUrl, CANONICALIZATION_VERSION } from './urlTextExtractor.js';

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/**
 * Extract plain text from an uploaded file's bytes, chosen by extension.
 * Errors are SafeFetchError (code + HTTP status) so routes handle one type.
 * @returns {Promise<{ text: string, kind: 'pdf'|'docx'|'text', pdfPages?: number }>}
 */
export async function extractTextFromBuffer(buffer, filename = '') {
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new SafeFetchError('too_large', `The file is larger than ${MAX_UPLOAD_BYTES} bytes`, 413);
  }
  const ext = (filename.split('.').pop() || '').toLowerCase();

  if (ext === 'pdf') {
    try {
      const data = await extractPdfText(buffer);
      return { text: data.text, kind: 'pdf', pdfPages: data.numpages };
    } catch (e) {
      if (e instanceof PdfExtractError) throw new SafeFetchError(e.code, e.message, e.status);
      throw new SafeFetchError('pdf_parse_failed', 'The PDF could not be read', 422);
    }
  }

  if (ext === 'docx') {
    try {
      const result = await mammoth.extractRawText({ buffer });
      return { text: result.value, kind: 'docx' };
    } catch {
      throw new SafeFetchError('docx_parse_failed', 'The DOCX file could not be read', 422);
    }
  }

  // .txt, .md, .json, .csv, .html (as raw source), or anything else: UTF-8 as-is.
  return { text: buffer.toString('utf-8'), kind: 'text' };
}
