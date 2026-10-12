import { LOCAL_FEED_SCHEMA, LOCAL_LIMITS, LOCAL_SOURCE_ID, type AuthoredFeed, type AuthoredReport } from './contracts.js';

const FEED_FIELDS = ['schemaVersion', 'datasetKind', 'sourceId', 'reports'] as const;
const REPORT_FIELDS = ['id', 'title', 'text', 'publishedAt', 'observedAt'] as const;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const URL_LIKE = /(?:https?:\/\/|\bwww\.|\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?\b)/i;

export class AuthoredFeedError extends Error {
  constructor(readonly code: 'invalid_json' | 'invalid_feed' | 'feed_too_large' | 'too_many_reports' | 'duplicate_report_id' | 'invalid_report') {
    super(code);
    this.name = 'AuthoredFeedError';
  }
}

/** Parses the fixed local synthetic feed format. No source URL or geometry is accepted. */
export function parseAuthoredFeed(text: string): AuthoredFeed {
  if (typeof text !== 'string') throw new AuthoredFeedError('invalid_feed');
  if (new TextEncoder().encode(text).byteLength > LOCAL_LIMITS.maxFeedBytes) {
    throw new AuthoredFeedError('feed_too_large');
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new AuthoredFeedError('invalid_json');
  }
  try {
    const feed = exactObject(value, FEED_FIELDS);
    if (feed.schemaVersion !== LOCAL_FEED_SCHEMA || feed.datasetKind !== 'synthetic' || feed.sourceId !== LOCAL_SOURCE_ID) {
      invalid('invalid_feed');
    }
    if (!Array.isArray(feed.reports) || feed.reports.length < 1) invalid('invalid_feed');
    if (feed.reports.length > LOCAL_LIMITS.maxReports) throw new AuthoredFeedError('too_many_reports');

    const ids = new Set<string>();
    const reports = feed.reports.map((entry): AuthoredReport => {
      const record = exactObject(entry, REPORT_FIELDS);
      const id = identifier(record.id);
      if (ids.has(id)) throw new AuthoredFeedError('duplicate_report_id');
      ids.add(id);
      const title = boundedText(record.title, 300);
      const reportText = boundedText(record.text, LOCAL_LIMITS.maxTextCodePoints);
      if (URL_LIKE.test(title) || URL_LIKE.test(reportText)) invalid('invalid_report');
      return {
        id,
        title,
        text: reportText,
        publishedAt: nullableTimestamp(record.publishedAt),
        observedAt: nullableTimestamp(record.observedAt),
      };
    });
    return {
      schemaVersion: LOCAL_FEED_SCHEMA,
      datasetKind: 'synthetic',
      sourceId: LOCAL_SOURCE_ID,
      reports,
    };
  } catch (error) {
    if (error instanceof AuthoredFeedError) throw error;
    throw new AuthoredFeedError('invalid_feed');
  }
}

function exactObject(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid('invalid_feed');
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== allowed.length || keys.some((key) => !allowed.includes(key))) invalid('invalid_feed');
  return record;
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) invalid('invalid_report');
  return value;
}

function boundedText(value: unknown, maximumCodePoints: number): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.includes('\0')) invalid('invalid_report');
  const count = Array.from(value).length;
  if (count < 1 || count > maximumCodePoints) invalid('invalid_report');
  return value;
}

function nullableTimestamp(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !RFC3339.test(value) || !Number.isFinite(Date.parse(value))) invalid('invalid_report');
  return value;
}

function invalid(code: 'invalid_feed' | 'invalid_report'): never {
  throw new AuthoredFeedError(code);
}
