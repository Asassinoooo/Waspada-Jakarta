/**
 * HOSTED-35a: a public title is cut at a word boundary, never mid-word. Pure, no network.
 */

const ELLIPSIS = "…";
// Trailing punctuation and whitespace that should not end a cut title. Percent and currency signs are kept.
const TRAILING_BREAK = /[\s.,;:!?\-–—/(\[{"'“”‘’…]+$/u;

/**
 * Returns text unchanged when it has at most `max` code points. Otherwise it cuts at the last whitespace that fits
 * beside the ellipsis, drops trailing punctuation, and appends "…". The result, ellipsis included, never exceeds `max`
 * code points. With no usable whitespace it cuts at the limit.
 */
export function truncateAtWord(text: string, max: number): string {
  if (!Number.isInteger(max) || max <= 0) return "";
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  if (max === 1) return ELLIPSIS;

  // One code point is reserved for the ellipsis.
  const head = chars.slice(0, max - 1).join("");
  const lastSpace = lastWhitespaceIndex(head);
  const atWord = lastSpace > 0 ? head.slice(0, lastSpace) : head;
  const cut = atWord.replace(TRAILING_BREAK, "");
  const base = cut.length > 0 ? cut : head.replace(TRAILING_BREAK, "");
  return `${base}${ELLIPSIS}`;
}

function lastWhitespaceIndex(text: string): number {
  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (/\s/u.test(text[index]!)) return index;
  }
  return -1;
}
