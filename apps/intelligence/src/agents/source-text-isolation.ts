/**
 * NFR-07 A1 (F-43): the one rule for source text in a model prompt. Every agent that writes source-derived text into
 * its prompt runs it through here, so a forged section header or output template in a feed, a webhook or a stored
 * report cannot start a second section of the prompt.
 */

/** The prefix that marks a source line as quoted data. */
export const SOURCE_TEXT_MARK = "[teks sumber] ";

/** A line of source text that imitates a prompt section header or the output template. Tested one line at a time. */
const SECTION_LOOKALIKE_LINE = /^\s*(?:={3,}.*={3,}\s*$|format your output)/iu;
const LINE_BREAK = /(\r\n|[\n\r\u2028\u2029])/u;

/**
 * NFR-07 A1: marks each source line that looks like a section header or the output template, so the model reads it as
 * quoted source and not as a second section. The prefix is the only change; every other character is kept.
 */
export function neutraliseSourceText(text: string): string {
  return text
    .split(LINE_BREAK)
    .map((part) => (SECTION_LOOKALIKE_LINE.test(part) ? `${SOURCE_TEXT_MARK}${part}` : part))
    .join("");
}

/**
 * NFR-07 A1 (F-43): a quote the model copies from a neutralised prompt carries the mark it was shown. The quote is
 * the source text when it appears in the original text, with or without that mark, so the mark never fabricates
 * a match: a quote absent from the original stays absent.
 */
export function quoteAppearsInSource(originalText: string, quote: string): boolean {
  if (originalText.includes(quote)) return true;
  return originalText.includes(quote.split(SOURCE_TEXT_MARK).join(""));
}
