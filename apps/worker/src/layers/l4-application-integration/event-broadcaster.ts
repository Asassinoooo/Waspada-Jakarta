/**
 * Server-Sent Events (SSE) Broadcaster for Waspada Jakarta.
 *
 * In-memory Pub/Sub broker managing connected SSE client writers
 * (WritableStreamDefaultWriter<Uint8Array>) for moderation command center
 * and public incident streams.
 */

export interface BroadcasterClientCount {
  readonly moderation: number;
  readonly public: number;
}

export interface EventBroadcasterOptions {
  /**
   * Interval in milliseconds for sending SSE keep-alive comments (`: ping\n\n`).
   * Defaults to 15,000 ms (15 seconds). Set to 0 or null to disable periodic pings.
   */
  readonly pingIntervalMs?: number | null;
}

export type ModerationStreamEvent =
  | "proposal_created"
  | "proposal_updated"
  | "proposal_published"
  | (string & {});

export type PublicStreamEvent =
  | "event_published"
  | "event_updated"
  | (string & {});

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  "Connection": "keep-alive",
} as const;

/**
 * Creates an HTTP Response configured for SSE streaming.
 */
export function createSSEResponse(
  stream: ReadableStream<Uint8Array>,
  init?: ResponseInit,
): Response {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "text/event-stream; charset=utf-8");
  headers.set("Cache-Control", "no-cache, no-transform");
  headers.set("Connection", "keep-alive");

  return new Response(stream, {
    ...init,
    status: init?.status ?? 200,
    headers,
  });
}

function safeJsonStringify(data: unknown): string {
  try {
    return JSON.stringify(data ?? null);
  } catch {
    return JSON.stringify({ error: "Failed to serialize event payload" });
  }
}

export class EventBroadcaster {
  private readonly encoder = new TextEncoder();
  private readonly moderationWriters = new Set<WritableStreamDefaultWriter<Uint8Array>>();
  private readonly publicWriters = new Set<WritableStreamDefaultWriter<Uint8Array>>();
  private readonly pingIntervalMs: number;
  private pingTimer: { unref?(): void } | number | null = null;

  constructor(options?: EventBroadcasterOptions) {
    this.pingIntervalMs = options?.pingIntervalMs ?? 15_000;
  }

  /**
   * Subscribes a moderation client to the SSE stream.
   *
   * @param signal Optional AbortSignal to disconnect and clean up the writer.
   * @returns ReadableStream of encoded SSE bytes.
   */
  public subscribeModeration(signal?: AbortSignal): ReadableStream<Uint8Array> {
    return this.createSubscription(this.moderationWriters, signal);
  }

  /**
   * Subscribes a public client to the SSE stream.
   *
   * @param signal Optional AbortSignal to disconnect and clean up the writer.
   * @returns ReadableStream of encoded SSE bytes.
   */
  public subscribePublicEvents(signal?: AbortSignal): ReadableStream<Uint8Array> {
    return this.createSubscription(this.publicWriters, signal);
  }

  /**
   * Broadcasts an event to all connected moderation clients.
   *
   * Format: `event: <event>\ndata: ${JSON.stringify(data)}\n\n`
   */
  public broadcastModeration(event: ModerationStreamEvent, data: unknown): void {
    const message = `event: ${event}\ndata: ${safeJsonStringify(data)}\n\n`;
    this.broadcastToSet(this.moderationWriters, message);
  }

  /**
   * Broadcasts an event to all connected public clients.
   *
   * Format: `event: <event>\ndata: ${JSON.stringify(data)}\n\n`
   */
  public broadcastPublic(event: PublicStreamEvent, data: unknown): void {
    const message = `event: ${event}\ndata: ${safeJsonStringify(data)}\n\n`;
    this.broadcastToSet(this.publicWriters, message);
  }

  /**
   * Returns the count of active connected SSE writers.
   */
  public getClientCount(): BroadcasterClientCount {
    return {
      moderation: this.moderationWriters.size,
      public: this.publicWriters.size,
    };
  }

  /**
   * Sends an immediate keep-alive comment (`: ping\n\n`) to all connected clients.
   */
  public sendPing(): void {
    const pingMessage = ": ping\n\n";
    this.broadcastToSet(this.moderationWriters, pingMessage);
    this.broadcastToSet(this.publicWriters, pingMessage);
  }

  /**
   * Closes all active client streams and clears ping intervals.
   */
  public close(): void {
    this.stopPingTimer();

    for (const writer of Array.from(this.moderationWriters)) {
      this.closeWriterQuietly(writer);
    }
    this.moderationWriters.clear();

    for (const writer of Array.from(this.publicWriters)) {
      this.closeWriterQuietly(writer);
    }
    this.publicWriters.clear();
  }

  /**
   * Resets all connections and timers (alias for close).
   */
  public reset(): void {
    this.close();
  }

  private createSubscription(
    writers: Set<WritableStreamDefaultWriter<Uint8Array>>,
    signal?: AbortSignal,
  ): ReadableStream<Uint8Array> {
    const transformStream = new TransformStream<Uint8Array, Uint8Array>();
    const writer = transformStream.writable.getWriter();

    if (signal?.aborted) {
      this.closeWriterQuietly(writer);
      return transformStream.readable;
    }

    writers.add(writer);
    this.ensurePingTimer();

    const cleanup = () => {
      writers.delete(writer);
      this.closeWriterQuietly(writer);
      this.maybeStopPingTimer();
    };

    if (signal) {
      signal.addEventListener("abort", cleanup, { once: true });
    }

    // Also observe writer closure if cancelled on the reader end
    writer.closed
      .catch(() => {})
      .finally(() => {
        writers.delete(writer);
        this.maybeStopPingTimer();
      });

    return transformStream.readable;
  }

  private broadcastToSet(
    writers: Set<WritableStreamDefaultWriter<Uint8Array>>,
    message: string,
  ): void {
    if (writers.size === 0) return;

    const encoded = this.encoder.encode(message);

    for (const writer of Array.from(writers)) {
      try {
        writer.write(encoded).catch(() => {
          writers.delete(writer);
          this.closeWriterQuietly(writer);
          this.maybeStopPingTimer();
        });
      } catch {
        writers.delete(writer);
        this.closeWriterQuietly(writer);
        this.maybeStopPingTimer();
      }
    }
  }

  private closeWriterQuietly(writer: WritableStreamDefaultWriter<Uint8Array>): void {
    try {
      writer.close().catch(() => {});
    } catch {}
  }

  private ensurePingTimer(): void {
    if (this.pingIntervalMs <= 0 || this.pingTimer !== null) return;

    this.pingTimer = setInterval(() => {
      this.sendPing();
    }, this.pingIntervalMs);

    if (this.pingTimer && typeof this.pingTimer === "object" && "unref" in this.pingTimer && typeof this.pingTimer.unref === "function") {
      this.pingTimer.unref();
    }
  }

  private maybeStopPingTimer(): void {
    if (this.moderationWriters.size === 0 && this.publicWriters.size === 0) {
      this.stopPingTimer();
    }
  }

  private stopPingTimer(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer as unknown as number);
      this.pingTimer = null;
    }
  }
}

/**
 * Singleton instance of EventBroadcaster for application-wide Pub/Sub.
 */
export const eventBroadcaster = new EventBroadcaster();
