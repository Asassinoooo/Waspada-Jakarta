import type { AuthoredFeed, LocalPipelineStore } from './contracts.js';

export interface LocalProcessor {
  processIngestion(): Promise<unknown>;
  processAi(): Promise<unknown>;
}
export interface LocalScheduleOptions {
  readonly store: LocalPipelineStore;
  readonly processor: LocalProcessor;
  readonly readFeed: () => Promise<AuthoredFeed>;
  readonly now: () => string;
  readonly intervalMs: number;
  readonly maxPolls: number;
  readonly signal?: AbortSignal;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly onPoll?: (result: { captured: number; unchanged: number }) => void;
  readonly onCollectionError?: () => void;
}

export async function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

/** Collection is serial, while one independent worker can await a bounded model call. */
export async function runLocalSchedule(options: LocalScheduleOptions): Promise<{ polls: number; collectionFailures: number }> {
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 1_000 || options.intervalMs > 3_600_000 ||
      !Number.isSafeInteger(options.maxPolls) || options.maxPolls < 1 || options.maxPolls > 10_000) {
    throw new Error('invalid_local_schedule');
  }
  const sleep = options.sleep ?? abortableSleep;
  let collectionFinished = false;
  let polls = 0;
  let collectionFailures = 0;
  let firstPollReady!: () => void;
  const ready = new Promise<void>((resolve) => { firstPollReady = resolve; });
  const collector = (async () => {
    try {
      for (; polls < options.maxPolls && !options.signal?.aborted; polls++) {
        try {
          const feed = await options.readFeed();
          const result = await options.store.capture(feed, options.now());
          options.onPoll?.(result);
        } catch {
          // Never propagate source payloads, provider errors, paths or credentials to logs.
          collectionFailures++;
          options.onCollectionError?.();
        } finally { firstPollReady(); }
        if (polls + 1 < options.maxPolls && !options.signal?.aborted) await sleep(options.intervalMs, options.signal);
      }
    } finally { collectionFinished = true; firstPollReady(); }
  })();
  const worker = (async () => {
    await ready;
    do {
      if (options.signal?.aborted) break;
      await options.store.recover(options.now());
      // One pass is finite: max20 authored items and no automatic waiting for retry backoff.
      // Drain ingestion first so model latency cannot strand already collected reports in L1.
      for (let i = 0; i < 20 && !options.signal?.aborted; i++) await options.processor.processIngestion();
      for (let i = 0; i < 20 && !options.signal?.aborted; i++) await options.processor.processAi();
      if (!collectionFinished && !options.signal?.aborted) await sleep(Math.min(options.intervalMs, 1_000), options.signal);
    } while (!collectionFinished && !options.signal?.aborted);
    // Final capture may occur while the worker is awaiting AI. Finish those L1 jobs too.
    if (!options.signal?.aborted) {
      for (let i = 0; i < 20; i++) await options.processor.processIngestion();
      for (let i = 0; i < 20; i++) await options.processor.processAi();
    }
  })();
  // Join both tasks even if the worker fails unexpectedly; never close the DB while
  // collection is still writing. Processors normally record their own job failures.
  const outcomes = await Promise.allSettled([collector, worker]);
  if (outcomes.some((outcome) => outcome.status === 'rejected')) throw new Error('local_schedule_failed');
  return { polls, collectionFailures };
}
