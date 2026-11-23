/**
 * PERF-04: a small in-isolate memo for successful public reads.
 *
 * The Worker builds its public runtimes per request (apps/worker/src/index.ts), so the entries cannot live on a runtime
 * instance. They live at module level and are scoped by the SQL runner the runtime was given. Production passes the
 * same runner function on every request, so one scope is shared by the isolate. A test that injects its own runner gets
 * a fresh scope, so results never leak between tests. Only successful bodies are stored by the callers.
 */
export const PUBLIC_READ_MEMO_LIMITS = Object.freeze({
  ttlMs: 30_000,
  maxEntries: 200,
});

export interface PublicReadMemo<Value> {
  /** Returns the stored value while it is younger than the TTL. An expired or future-dated entry is dropped. */
  get(key: string, nowMs: number): Value | undefined;
  /** Stores a successful value. The oldest insertion is evicted once the entry limit is exceeded. */
  set(key: string, value: Value, nowMs: number): void;
}

interface MemoEntry {
  readonly value: unknown;
  readonly storedAtMs: number;
}

const entriesByScope = new WeakMap<object, Map<string, Map<string, MemoEntry>>>();

export function createPublicReadMemo<Value>(scope: object, namespace: string): PublicReadMemo<Value> {
  const entries = memoEntries(scope, namespace);
  return {
    get(key: string, nowMs: number): Value | undefined {
      const entry = entries.get(key);
      if (entry === undefined) return undefined;
      const ageMs = nowMs - entry.storedAtMs;
      if (ageMs < 0 || ageMs >= PUBLIC_READ_MEMO_LIMITS.ttlMs) {
        entries.delete(key);
        return undefined;
      }
      return entry.value as Value;
    },
    set(key: string, value: Value, nowMs: number): void {
      entries.delete(key);
      entries.set(key, { value, storedAtMs: nowMs });
      while (entries.size > PUBLIC_READ_MEMO_LIMITS.maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done === true) break;
        entries.delete(oldest.value);
      }
    },
  };
}

function memoEntries(scope: object, namespace: string): Map<string, MemoEntry> {
  let namespaces = entriesByScope.get(scope);
  if (namespaces === undefined) {
    namespaces = new Map();
    entriesByScope.set(scope, namespaces);
  }
  let entries = namespaces.get(namespace);
  if (entries === undefined) {
    entries = new Map();
    namespaces.set(namespace, entries);
  }
  return entries;
}
