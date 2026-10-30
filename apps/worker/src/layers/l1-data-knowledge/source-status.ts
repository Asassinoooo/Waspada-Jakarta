import type { PublicContext } from "../../contracts/public-api.js";

export interface SourceStatusProvider {
  listPublicSourceStatus(): PublicContext["sources"];
}

// BOOT-01 has no real source connectors. An empty registry is honest coverage,
// not an all-clear signal.
export const noConfiguredSources: SourceStatusProvider = {
  listPublicSourceStatus: () => [],
};

export interface LiveSourceRecord {
  readonly id: string;
  readonly display_name: string;
  readonly kind: "rss" | "sensor" | "webhook" | "api";
  health: "healthy" | "degraded" | "unavailable" | "unknown";
  last_success_at: string | null;
  items_parsed?: number;
}

export class LiveSourceStatusRegistry implements SourceStatusProvider {
  private readonly sources = new Map<string, LiveSourceRecord>([
    ["source-antara-metro", { id: "source-antara-metro", display_name: "LKBN ANTARA Metro (RSS)", kind: "rss", health: "healthy", last_success_at: new Date().toISOString() }],
    ["source-antara-hukum", { id: "source-antara-hukum", display_name: "LKBN ANTARA Kriminalitas & Hukum (RSS)", kind: "rss", health: "healthy", last_success_at: new Date().toISOString() }],
    ["source-antara-terkini", { id: "source-antara-terkini", display_name: "LKBN ANTARA Terkini (RSS)", kind: "rss", health: "healthy", last_success_at: new Date().toISOString() }],
    ["source-antara-wartabumi", { id: "source-antara-wartabumi", display_name: "LKBN ANTARA Warta Bumi (RSS)", kind: "rss", health: "healthy", last_success_at: new Date().toISOString() }],
    ["source-detik-news", { id: "source-detik-news", display_name: "Detikcom Megapolitan (RSS)", kind: "rss", health: "healthy", last_success_at: new Date().toISOString() }],
    ["source-cnn-nasional", { id: "source-cnn-nasional", display_name: "CNN Indonesia Nasional (RSS)", kind: "rss", health: "healthy", last_success_at: new Date().toISOString() }],
    ["source-cnbc-news", { id: "source-cnbc-news", display_name: "CNBC Indonesia Transportasi (RSS)", kind: "rss", health: "healthy", last_success_at: new Date().toISOString() }],
    ["source-sindonews-daerah", { id: "source-sindonews-daerah", display_name: "SINDOnews Metro Daerah (RSS)", kind: "rss", health: "healthy", last_success_at: new Date().toISOString() }],
    ["source-tempo-nasional", { id: "source-tempo-nasional", display_name: "Tempo.co Nasional (RSS)", kind: "rss", health: "healthy", last_success_at: new Date().toISOString() }],
    ["source-petabencana", { id: "source-petabencana", display_name: "PetaBencana.id Realtime Banjir (API)", kind: "api", health: "healthy", last_success_at: new Date().toISOString() }],
    ["source-bmkg-gempa", { id: "source-bmkg-gempa", display_name: "BMKG TEWS Gempabumi & Cuaca (API)", kind: "sensor", health: "healthy", last_success_at: new Date().toISOString() }],
    ["source-webhook-ingest", { id: "source-webhook-ingest", display_name: "Gateway Webhook Insiden Lalu Lintas & Darurat", kind: "webhook", health: "healthy", last_success_at: new Date().toISOString() }],
  ]);

  recordSuccess(sourceId: string, itemsCount = 1): void {
    const s = this.sources.get(sourceId);
    if (s) {
      s.health = "healthy";
      s.last_success_at = new Date().toISOString();
      s.items_parsed = (s.items_parsed ?? 0) + itemsCount;
    }
  }

  recordFailure(sourceId: string): void {
    const s = this.sources.get(sourceId);
    if (s) {
      s.health = "degraded";
    }
  }

  listPublicSourceStatus(): PublicContext["sources"] {
    return Array.from(this.sources.values()).map((s) => ({
      display_name: s.display_name,
      health: s.health,
      last_success_at: s.last_success_at,
    }));
  }
}

export const liveSourceStatusRegistry = new LiveSourceStatusRegistry();
