/**
 * AI-RPM-01 local live cycle knobs (serve:live). Parsed here so the defaults
 * and the fallbacks on bad input are unit-tested without starting the server.
 */
export const DEFAULT_LIVE_RSS_MAX_AGE_HOURS = 6;
export const DEFAULT_LIVE_MAX_NEW_ITEMS_PER_CYCLE = 5;

export interface LiveCycleConfig {
  /** Article age limit for every RSS feed (Stage A stale check and the parse filter). */
  readonly rssMaxAgeHours: number;
  /**
   * New Stage B model triage calls allowed per poll cycle, across all feeds.
   * Items past the cap wait for a later cycle; they are not persisted as decided.
   */
  readonly maxNewItemsPerCycle: number;
}

function readEnvText(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function parseLiveCycleConfig(env: Readonly<Record<string, string | undefined>>): LiveCycleConfig {
  const ageText = readEnvText(env.LIVE_RSS_MAX_AGE_HOURS);
  const ageValue = ageText === null ? Number.NaN : Number(ageText);
  const capText = readEnvText(env.LIVE_MAX_NEW_ITEMS_PER_CYCLE);
  const capValue = capText === null ? Number.NaN : Number(capText);
  return {
    rssMaxAgeHours: Number.isFinite(ageValue) && ageValue > 0 ? ageValue : DEFAULT_LIVE_RSS_MAX_AGE_HOURS,
    maxNewItemsPerCycle: Number.isInteger(capValue) && capValue >= 0
      ? capValue
      : DEFAULT_LIVE_MAX_NEW_ITEMS_PER_CYCLE,
  };
}
