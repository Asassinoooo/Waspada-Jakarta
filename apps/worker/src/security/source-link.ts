/**
 * NFR-07 A4: the one rule for a source link that a claim or a stored report revision may carry.
 *
 * A link passes only when it is https, has no username or password, has no whitespace, is 9 to 2048 characters,
 * and has no credential-like query parameter. RSS intake, the automatic and moderator publication gates, and public
 * attribution all call this function. So a link that intake keeps is one the gate accepts, and one that the gate
 * accepts is one attribution can show. A link that fails it is never shown publicly.
 *
 * Pure: no network, no database. Lives under security/ so that L1 intake and L4 publication can both import it
 * without one layer importing the other.
 */

/** A query parameter named like a credential. A link carrying one is never shown publicly. */
const CREDENTIAL_PARAM_PATTERN = /^(api[-_]?key|apikey|key|token|access[-_]?token|auth|secret|signature|sig|password)$/iu;

/** The trimmed link when it passes the shared rule, or null. */
export function publicSourceLinkFor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const url = value.trim();
  if (url.length < 9 || url.length > 2048 || /\s/u.test(url) || !url.startsWith("https://")) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") return null;
  for (const name of parsed.searchParams.keys()) {
    if (CREDENTIAL_PARAM_PATTERN.test(name)) return null;
  }
  return url;
}
