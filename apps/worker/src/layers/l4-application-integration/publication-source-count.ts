/*
 * HOSTED-28 (owner decision, 18 Nov 2026; F-09): the publication source_count is the number of distinct outlets. A
 * syndicated copy is not counted. A copy is another outlet that repeats a report an earlier outlet already carried.
 *
 * This is the worker's copy of the rule the public card uses: countIndependentSources in
 * apps/web/src/published-events.ts. The worker must not import web code, so the rule is written out again here. Keep
 * the two in step. apps/worker/test/hosted28-source-count.test.ts holds the fixture cases, and each case gives the same
 * outlets and copies in both implementations.
 *
 * The claim shape is the one the public projection reads (public-read-model.ts): the outlet name, the source link and
 * the claim text. A claim counts only when it has a source link, because only then does the public card show a source.
 */

/** The outlet name the public projection shows when a source link names no outlet. */
const UNNAMED_OUTLET = "Sumber tanpa nama";

/** The claim text the public projection uses when a claim has neither claim_text nor quote_text. It is a placeholder, never a title. */
const UNTITLED_CLAIM_TEXT = "Klaim laporan";

export interface OutletClaim {
  readonly outlet?: string | null;
  readonly source_url?: string | null;
  readonly claim_text?: string | null;
  readonly quote_text?: string | null;
}

export interface OutletCount {
  /** Distinct outlets that are not copies. This is the publication source_count. */
  readonly outlets: number;
  /** Outlets that only repeat reports an earlier outlet carried. They are labelled, never counted. */
  readonly copies: number;
}

/** Normalised title for copy matching: lowercase, punctuation as spaces, whitespace collapsed. Empty when there is no usable title. */
function normalisedTitle(text: string): string {
  if (text.trim() === UNTITLED_CLAIM_TEXT) return "";
  return text.toLocaleLowerCase("id").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/gu, " ").trim();
}

/**
 * Splits the named outlets of the claims into outlets and copies. Two claims from different outlets carry the same report
 * when their normalised titles are equal. The claim text stands in for a title, because the public DTO has no article
 * title. Outlets are visited most-distinct-titles first, then by name, so claims[] order does not change the result. An
 * outlet is a copy when each of its claims repeats a title that an earlier outlet already carried. An outlet with an
 * untitled claim is never a copy.
 */
export function countPublicationOutlets(claims: readonly OutletClaim[]): OutletCount {
  const byOutlet = new Map<string, { titles: Set<string>; untitled: boolean }>();
  for (const claim of claims) {
    if (typeof claim.source_url !== "string" || claim.source_url.length === 0) continue;
    const title = normalisedTitle(claim.claim_text || claim.quote_text || UNTITLED_CLAIM_TEXT);
    const name = (typeof claim.outlet === "string" && claim.outlet.length > 0 ? claim.outlet : UNNAMED_OUTLET).trim();
    if (name.length === 0) continue;
    const entry = byOutlet.get(name) ?? { titles: new Set<string>(), untitled: false };
    if (title.length === 0) entry.untitled = true;
    else entry.titles.add(title);
    byOutlet.set(name, entry);
  }

  const ordered = [...byOutlet.entries()].sort(([nameA, a], [nameB, b]) => {
    if (a.titles.size !== b.titles.size) return b.titles.size - a.titles.size;
    return nameA < nameB ? -1 : nameA > nameB ? 1 : 0;
  });
  const covered = new Set<string>();
  let outlets = 0;
  for (const [, entry] of ordered) {
    const copy = !entry.untitled && entry.titles.size > 0 && [...entry.titles].every((title) => covered.has(title));
    if (copy) continue;
    outlets += 1;
    for (const title of entry.titles) covered.add(title);
  }
  return { outlets, copies: ordered.length - outlets };
}
