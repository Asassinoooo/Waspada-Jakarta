import * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatInstant } from "./display.js";
import { InteractiveIncidentMap } from "./InteractiveIncidentMap.js";
import { listEvents } from "./api-client.js";
import {
  type EventProposalDto,
  type StoredEvidenceChunk,
  ModerationHttpError,
  proposalCategoryLabel,
  severityLabel,
  isProposalMultiSource,
  renderHighlightedText,
} from "./ModeratorReview.js";


if (typeof document !== "undefined") {
  void import("./moderator-review.css");
}

/**
 * The catalog reads the moderation endpoint, which answers 401/403 to visitors without a moderator
 * session. Show a plain access message instead of a raw HTTP error.
 */
export function catalogLoadErrorMessage(err: unknown): string {
  if (err instanceof ModerationHttpError && (err.status === 401 || err.status === 403)) {
    return "Katalog ini hanya tersedia untuk moderator yang sudah masuk.";
  }
  return `Gagal memuat katalog laporan terpercaya: ${err instanceof Error ? err.message : String(err)}`;
}

export interface LaporanPublikProps {
  initialProposals?: readonly EventProposalDto[];
  initialSelectedId?: string;
}

type PublicEventView = Awaited<ReturnType<typeof listEvents>>["data"][number];

/**
 * MERGE-REVIEW-01: one card per published public event. The public API carries no severity,
 * no moderation queue and no evidence chunks, so none are invented here. A claim lists only its
 * own source link.
 */
export function publicEventToCard(event: PublicEventView): EventProposalDto {
  const detail = event as unknown as {
    geometries?: readonly { geometry: { type: string; coordinates?: unknown } }[];
    publication?: { mode: "agent_auto" | "moderator_reviewed"; source_count: number };
  };
  const point = detail.geometries?.find((geometry) => geometry.geometry.type === "Point");
  const coordinates = point && Array.isArray(point.geometry.coordinates) && point.geometry.coordinates.length === 2
    ? (point.geometry.coordinates as [number, number])
    : null;
  const claims = event.claims.map((claim) => {
    const source = claim.sources[0];
    return {
      claim_id: claim.claim_id,
      claim_text: claim.text,
      evidence_label: claim.evidence_label,
      support_assessment: "supported",
      quote_text: source?.excerpt ?? "",
      evidence_ref_id: "",
      source_id: null,
      outlet: source?.display_name ?? null,
      source_url: source?.url ?? null,
    };
  });
  const distinctPublishers = new Set(claims.map((claim) => claim.outlet).filter((outlet): outlet is string => Boolean(outlet)));
  const sourceCount = detail.publication?.source_count ?? distinctPublishers.size;
  return {
    schema_version: "2.0",
    proposal_id: event.event_id,
    title: event.title,
    incident_type: event.incident_type ?? event.category,
    primary_category: event.category,
    severity: "unknown",
    event_time: { precision: event.event_time.precision, value: event.event_time.start ?? null },
    location_label: event.scope.places[0] ?? null,
    coordinates,
    claims,
    impacts: [],
    is_multi_source: sourceCount >= 2,
    source_count: sourceCount,
    has_discrepancy: false,
    discrepancies: [],
    caveats: [],
    proposed_at: event.published_at,
    publication_mode: detail.publication?.mode ?? null,
  } as unknown as EventProposalDto;
}

/** Badge text for a published version. It states who published it and how many media reported it. */
export function publicationBadgeText(proposal: EventProposalDto): string {
  const reach = typeof proposal.source_count === "number" ? ` · dilaporkan oleh ${proposal.source_count} media` : "";
  return proposal.publication_mode === "moderator_reviewed"
    ? `Ditinjau moderator${reach}`
    : `Diringkas otomatis oleh agen AI${reach}`;
}

export function LaporanPublik({
  initialProposals,
  initialSelectedId,
}: LaporanPublikProps): React.JSX.Element {
  const [proposals, setProposals] = useState<EventProposalDto[]>(() =>
    initialProposals ? [...initialProposals] : []
  );
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    initialSelectedId ?? initialProposals?.[0]?.proposal_id ?? null
  );
  // Track which card is expanded (exclusive: at most one card expanded at a time)
  const [expandedId, setExpandedId] = useState<string | null>(() => initialSelectedId ?? null);
  const [chunksMap] = useState<Record<string, readonly StoredEvidenceChunk[]>>({});
  const [loading, setLoading] = useState<boolean>(!initialProposals);
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showEvidenceModal, setShowEvidenceModal] = useState<boolean>(false);
  const mapSectionRef = useRef<HTMLDivElement | null>(null);

  // 1. MERGE-REVIEW-01: the public page reads only published versions from the public events API.
  // It never reads the moderation queue.
  useEffect(() => {
    if (initialProposals) {
      setProposals([...initialProposals]);
      if (!selectedId && initialProposals.length > 0) {
        setSelectedId(initialProposals[0]!.proposal_id);
      }
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    listEvents()
      .then((page) => {
        if (cancelled) return;
        const cards = page.data.map(publicEventToCard);
        setProposals(cards);
        if (cards.length > 0 && !selectedId) {
          setSelectedId(cards[0]!.proposal_id);
        }
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoading(false);
        setErrorMessage(`Gagal memuat laporan publik: ${err instanceof Error ? err.message : String(err)}`);
      });

    return () => {
      cancelled = true;
    };
  }, [initialProposals, selectedId]);

  // MERGE-REVIEW-01: evidence chunks come from the moderator endpoint only, so this public page does not load them.

  const selectedProposal = useMemo(() => {
    if (!selectedId) return proposals[0] ?? null;
    return proposals.find((p) => p.proposal_id === selectedId) ?? proposals[0] ?? null;
  }, [proposals, selectedId]);

  const currentQuotes = useMemo(() => {
    if (!selectedProposal) return [];
    return selectedProposal.claims.map((c) => c.quote_text).filter(Boolean);
  }, [selectedProposal]);

  const currentChunks = selectedProposal ? chunksMap[selectedProposal.proposal_id] : undefined;

  const relevantChunks = useMemo(() => {
    if (!currentChunks || currentChunks.length === 0) return [];
    if (!currentQuotes || currentQuotes.length === 0) return currentChunks;
    return currentChunks.filter((chunk) => {
      const chunkLower = chunk.text.toLowerCase();
      return currentQuotes.some((q) => {
        const qLower = q.toLowerCase();
        return (
          chunkLower.includes(qLower) ||
          qLower.includes(chunkLower) ||
          qLower.split(/\s+/).filter((w) => w.length >= 4).some((w) => chunkLower.includes(w))
        );
      });
    });
  }, [currentChunks, currentQuotes]);

  const categoryOf = (p: EventProposalDto): string =>
    p.primary_category ?? p.compatibility_category ?? p.incident_type;

  const multiSourceCount = useMemo(() => {
    return proposals.filter((p) => isProposalMultiSource(p)).length;
  }, [proposals]);

  const filteredProposals = useMemo(() => {
    let list = proposals;

    // Filter by category
    if (categoryFilter === "multi_source") {
      list = list.filter((p) => isProposalMultiSource(p));
    } else if (categoryFilter === "flood") {
      list = list.filter((p) => {
        const c = categoryOf(p).toLowerCase();
        return c === "flood" || c === "disasters_weather" || c.includes("banjir") || c.includes("hujan");
      });
    } else if (categoryFilter === "fire") {
      list = list.filter((p) => {
        const c = categoryOf(p).toLowerCase();
        return (
          c === "fire" ||
          c === "fires_infrastructure_hazards" ||
          c.includes("kebakaran") ||
          c.includes("pohon") ||
          c.includes("gas")
        );
      });
    } else if (categoryFilter === "traffic") {
      list = list.filter((p) => {
        const c = categoryOf(p).toLowerCase();
        return (
          c === "transport_road_incidents" ||
          c.includes("lalu lintas") ||
          c.includes("transjakarta") ||
          c.includes("kecelakaan")
        );
      });
    } else if (categoryFilter === "security") {
      list = list.filter((p) => {
        const c = categoryOf(p).toLowerCase();
        return (
          c === "crime_personal_security" ||
          c.includes("jambret") ||
          c.includes("narkoba") ||
          c.includes("tawuran") ||
          c.includes("perkelahian") ||
          c.includes("kejahatan")
        );
      });
    } else if (categoryFilter === "other") {
      list = list.filter((p) => {
        const c = categoryOf(p).toLowerCase();
        return (
          !c.includes("banjir") &&
          !c.includes("hujan") &&
          !c.includes("kebakaran") &&
          !c.includes("pohon") &&
          !c.includes("gas") &&
          !c.includes("lalu lintas") &&
          !c.includes("transjakarta") &&
          !c.includes("kecelakaan") &&
          !c.includes("jambret") &&
          !c.includes("narkoba") &&
          !c.includes("tawuran")
        );
      });
    }

    // Filter by search query
    if (searchQuery.trim().length > 0) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter((p) => {
        const titleMatch = p.title.toLowerCase().includes(q);
        const locMatch = p.location_label?.toLowerCase().includes(q) ?? false;
        const claimMatch = p.claims.some(
          (c) => c.claim_text.toLowerCase().includes(q) || c.quote_text.toLowerCase().includes(q)
        );
        return titleMatch || locMatch || claimMatch;
      });
    }

    return list;
  }, [proposals, categoryFilter, searchQuery]);

  const handleSelectProposal = (proposal: EventProposalDto, scrollUp = false) => {
    setSelectedId(proposal.proposal_id);
    setExpandedId(proposal.proposal_id);
    if (scrollUp && mapSectionRef.current) {
      mapSectionRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  const handleCardClick = (proposal: EventProposalDto) => {
    setSelectedId(proposal.proposal_id);
    setExpandedId((current) => (current === proposal.proposal_id ? null : proposal.proposal_id));
  };

  return (
    <main id="main-content" className="main-shell">
      {/* 1. Header Halaman: Judul Berdiri Sendiri, Deskripsi Menjadi Sub-Heading di Bawahnya */}
      <section className="laporan-intro-section" aria-labelledby="discover-title">
        <h1 id="discover-title">Laporan Publik</h1>
        <p className="laporan-intro-copy">
          Katalog insiden yang sudah diterbitkan. Setiap laporan menampilkan siapa yang menerbitkannya dan berapa media yang melaporkannya,
          grounding kutipan berita verbatim, dan diterbitkan untuk masyarakat. Peta di atas menampilkan geometri koordinat
          dan sebaran fasilitas darurat terdekat.
        </p>
      </section>

      <hr/>

      {errorMessage && (
        <div className="feedback-banner feedback-banner--error" role="alert" style={{ marginBottom: "1rem" }}>
          <span>{errorMessage}</span>
          <button
            type="button"
            className="feedback-dismiss"
            onClick={() => setErrorMessage(null)}
            aria-label="Tutup pesan error"
          >
            ×
          </button>
        </div>
      )}

      {/* 3. Kontrol Pencarian (Melebar ke Kanan) & Tag Tombol Kategori */}
      <section className="discovery-controls--full-width" aria-label="Pencarian dan filter daftar laporan">
        <label htmlFor="event-search" style={{ fontSize: "0.88rem", fontWeight: 700, color: "var(--tinta-kota)" }}>
          Cari dalam daftar API yang dimuat
        </label>
        <div className="search-control">
          <span aria-hidden="true" className="search-glyph">⌕</span>
          <input
            autoComplete="off"
            id="event-search"
            name="q"
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Contoh: jambret, banjir di Jakarta, kebakaran, kecelakaan…"
          />
          {searchQuery.length > 0 && (
            <button className="search-clear" type="button" onClick={() => setSearchQuery("")}>
              Hapus
            </button>
          )}
        </div>

        {/* Filter Kategori: Pressable Button Tags */}
        <div className="category-tags-row" role="group" aria-label="Filter kategori laporan">
          <button
            type="button"
            className={`category-tag-btn ${categoryFilter === "all" ? "category-tag-btn--active" : ""}`}
            onClick={() => setCategoryFilter("all")}
          >
            Semua ({proposals.length})
          </button>
          {multiSourceCount > 0 && (
            <button
              type="button"
              className={`category-tag-btn ${categoryFilter === "multi_source" ? "category-tag-btn--active" : ""}`}
              onClick={() => setCategoryFilter("multi_source")}
            >
              Dilaporkan oleh 2+ media ({multiSourceCount})
            </button>
          )}
          <button
            type="button"
            className={`category-tag-btn ${categoryFilter === "flood" ? "category-tag-btn--active" : ""}`}
            onClick={() => setCategoryFilter("flood")}
          >
            🌊 Banjir &amp; Cuaca
          </button>
          <button
            type="button"
            className={`category-tag-btn ${categoryFilter === "fire" ? "category-tag-btn--active" : ""}`}
            onClick={() => setCategoryFilter("fire")}
          >
            🔥 Kebakaran &amp; Bahaya
          </button>
          <button
            type="button"
            className={`category-tag-btn ${categoryFilter === "traffic" ? "category-tag-btn--active" : ""}`}
            onClick={() => setCategoryFilter("traffic")}
          >
            🚗 Transportasi &amp; Lalin
          </button>
          <button
            type="button"
            className={`category-tag-btn ${categoryFilter === "security" ? "category-tag-btn--active" : ""}`}
            onClick={() => setCategoryFilter("security")}
          >
            🚨 Keamanan &amp; Kriminalitas
          </button>
          <button
            type="button"
            className={`category-tag-btn ${categoryFilter === "other" ? "category-tag-btn--active" : ""}`}
            onClick={() => setCategoryFilter("other")}
          >
            📋 Kategori Lainnya
          </button>
          {(categoryFilter !== "all" || searchQuery.length > 0) && (
            <button
              type="button"
              className="category-tag-btn category-tag-btn--clear"
              onClick={() => {
                setCategoryFilter("all");
                setSearchQuery("");
              }}
            >
              ✕ Reset Filter
            </button>
          )}
        </div>

        <p className="search-help" style={{ margin: "0.25rem 0 0", color: "var(--quiet-ink)", fontSize: "0.85rem" }}>
          Pencarian dan filter berlaku pada {filteredProposals.length} record yang sudah dimuat dari katalog ini.
        </p>
      </section>

      {/* Grid Vertikal: Peta di Atas, Daftar Record di Bawah */}
      <div className="discovery-grid">
        {/* ============================================================== */}
        {/* 4. PETA DI ATAS (MAP ABOVE): Menggunakan InteractiveIncidentMap */}
        {/* ============================================================== */}
        <div className="map-column" ref={mapSectionRef}>
          <section className="map-panel" aria-labelledby="map-title" style={{ borderRadius: "8px", overflow: "hidden" }}>
            <header className="panel-heading map-panel__heading" style={{ padding: "0.85rem 1.15rem", borderBottom: "1px solid var(--beton)" }}>
              <div>
                <p className="section-kicker">Geometri Spasial &amp; Fasilitas Sekitar dari Respons API</p>
                <h2 id="map-title" style={{ margin: 0, fontSize: "1.25rem" }}>
                  Peta Koordinat Interaktif
                </h2>
              </div>
              <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                <span className="fixture-chip" style={{ background: "#f0fdf4", color: "#166534", borderColor: "#bbf7d0" }}>
                  Tile OSM Interaktif
                </span>
                <span className="fixture-chip">Fasilitas sekitar</span>
              </div>
            </header>

            <p className="map-panel__intro" style={{ padding: "0.6rem 1.15rem", margin: 0, borderBottom: "1px solid var(--beton)", fontSize: "0.875rem" }}>
              Hanya geometri yang dikembalikan API untuk laporan terbit yang ditampilkan. Klik tombol fasilitas (RS, Polisi, Damkar) untuk melihat sebaran pos darurat di sekitar insiden.
            </p>

            {/* Peta Interaktif OSM Tinjau Bukti */}
            <div style={{ position: "relative", width: "100%", background: "#e2e8f0" }}>
              <InteractiveIncidentMap
                coordinates={selectedProposal?.coordinates ?? [106.8456, -6.2088]}
                incidentType={selectedProposal?.incident_type ?? "unknown"}
                severity={selectedProposal?.severity ?? "unknown"}
                locationLabel={selectedProposal?.location_label ?? "DKI Jakarta"}
                title={selectedProposal?.title ?? "Pilih insiden dari daftar di bawah"}
                activeQuote={currentQuotes[0]}
                height={460}
              />
            </div>

            {/* Panel Ringkasan Insiden Aktif yang Dipetakan (Sesuai Screenshot Referensi) */}
            {selectedProposal && (
              <div className="map-caption" style={{ padding: "1rem 1.15rem", background: "var(--surface)", borderTop: "1px solid var(--beton)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "0.75rem", marginBottom: "0.65rem" }}>
                  <div style={{ flex: "1 1 300px" }}>
                    <span style={{ fontSize: "0.75rem", fontWeight: 700, color: "var(--kali-teal)", textTransform: "uppercase", letterSpacing: "0.04em", display: "block", marginBottom: "0.2rem" }}>
                      Insiden Terpilih di Peta
                    </span>
                    <strong style={{ fontSize: "1.08rem", color: "var(--tinta-kota)", lineHeight: 1.4 }}>
                      {selectedProposal.title}
                    </strong>
                  </div>
                  <button
                    type="button"
                    className="button button--quiet"
                    onClick={() => setShowEvidenceModal(true)}
                    style={{ fontSize: "0.85rem", padding: "0.45rem 0.85rem", borderRadius: "6px", display: "inline-flex", alignItems: "center", gap: "0.4rem", cursor: "pointer" }}
                  >
                    <span>📄</span>
                    <strong>Buka Kutipan Bukti ({selectedProposal.claims.length} Klaim)</strong>
                  </button>
                </div>

                <dl className="coordinate-row" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "0.65rem", margin: 0, fontSize: "0.85rem" }}>
                  <div>
                    <dt style={{ color: "var(--quiet-ink)", fontSize: "0.78rem" }}>Koordinat CRS84</dt>
                    <dd style={{ margin: 0, fontWeight: 600 }}>
                      {selectedProposal.coordinates
                        ? `${selectedProposal.coordinates[0].toFixed(4)}, ${selectedProposal.coordinates[1].toFixed(4)}`
                        : "Tidak tercatat"}
                    </dd>
                  </div>
                  <div>
                    <dt style={{ color: "var(--quiet-ink)", fontSize: "0.78rem" }}>Wilayah Kejadian</dt>
                    <dd style={{ margin: 0, fontWeight: 600 }}>{selectedProposal.location_label || "DKI Jakarta"}</dd>
                  </div>
                  <div>
                    <dt style={{ color: "var(--quiet-ink)", fontSize: "0.78rem" }}>Cara Penerbitan</dt>
                    <dd style={{ margin: 0, fontWeight: 600 }}>
                      {publicationBadgeText(selectedProposal)}
                    </dd>
                  </div>
                  {selectedProposal.claims.some((claim) => claim.source_url) && (
                    <div>
                      <dt style={{ color: "var(--quiet-ink)", fontSize: "0.78rem" }}>Sumber laporan</dt>
                      <dd style={{ margin: 0, fontWeight: 600 }}>
                        <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
                          {selectedProposal.claims
                            .filter((claim) => claim.source_url)
                            .map((claim) => (
                              <li key={`src-${claim.claim_id}`}>
                                <a href={claim.source_url ?? undefined} target="_blank" rel="noopener noreferrer">
                                  {claim.outlet ?? "Sumber"}
                                </a>
                              </li>
                            ))}
                        </ul>
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt style={{ color: "var(--quiet-ink)", fontSize: "0.78rem" }}>Tingkat Dampak</dt>
                    <dd style={{ margin: 0, fontWeight: 600 }}>{severityLabel(selectedProposal.severity)}</dd>
                  </div>
                </dl>
              </div>
            )}
          </section>
        </div>

        {/* ============================================================== */}
        {/* 5. HALAMAN DAFTAR RECORD DI BAWAH (THE RECORD LIST BELOW)       */}
        {/* ============================================================== */}
        <section className="feed-panel" aria-labelledby="feed-title" style={{ borderRadius: "8px" }}>
          <header className="panel-heading">
            <div>
              <p className="section-kicker">Halaman data dari API</p>
              <h2 id="feed-title" style={{ margin: 0 }}>Daftar record</h2>
            </div>
            {!loading && (
              <span className="count-chip" aria-live="polite">
                {filteredProposals.length} cocok dari {proposals.length} record dimuat
              </span>
            )}
          </header>

          {loading && (
            <div className="state-panel state-panel--loading" role="status">
              <span className="loading-rule" aria-hidden="true" />
              <strong>Memuat record laporan terbit dari API…</strong>
              <span>Menyiapkan feed warta resmi masyarakat.</span>
            </div>
          )}

          {!loading && filteredProposals.length === 0 && (
            <div className="state-panel" role="status">
              <strong>Tidak ada laporan yang cocok dengan pencarian dan filter ini.</strong>
              <p>Hasil kosong bukan pernyataan bahwa seluruh wilayah aman.</p>
              <button
                className="button button--quiet"
                type="button"
                onClick={() => {
                  setSearchQuery("");
                  setCategoryFilter("all");
                }}
              >
                Hapus semua filter dan pencarian
              </button>
            </div>
          )}

          {!loading && filteredProposals.length > 0 && (
            <ul className="event-list" aria-label="Record event dari halaman API yang dimuat">
              {filteredProposals.map((proposal) => {
                const isSelected = selectedProposal?.proposal_id === proposal.proposal_id;
                const isExpanded = expandedId === proposal.proposal_id;
                const isMulti = isProposalMultiSource(proposal);

                return (
                  <li key={proposal.proposal_id}>
                    <article
                      className={`event-card event-card--collapsible ${isSelected ? " event-card--selected" : ""}`}
                      style={{
                        borderRadius: "8px",
                        padding: "0.85rem 1rem",
                        borderColor: isSelected ? "var(--kali-teal)" : undefined,
                      }}
                      onClick={() => handleCardClick(proposal)}
                      tabIndex={0}
                      role="button"
                      aria-expanded={isExpanded}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          handleCardClick(proposal);
                        }
                      }}
                    >
                      {/* Topline Header: Selalu Ditampilkan */}
                      <div className="event-card__topline" style={{ marginBottom: "0.45rem" }}>
                        <span
                          className="event-card__dataset-label"
                          style={{
                            fontWeight: 600,
                            color: isMulti ? "#15803d" : "#0284c7",
                            background: isMulti ? "#f0fdf4" : "#f0f9ff",
                            padding: "0.2rem 0.5rem",
                            borderRadius: "4px",
                            fontSize: "0.78rem",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "0.3rem",
                          }}
                        >
                          {publicationBadgeText(proposal)}
                        </span>
                        <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                          <span className="event-card__version" style={{ fontWeight: 600 }}>v{proposal.schema_version}</span>
                          <span
                            style={{
                              fontSize: "0.75rem",
                              color: isSelected ? "var(--kali-teal)" : "var(--quiet-ink)",
                              transform: isExpanded ? "rotate(180deg)" : "rotate(0deg)",
                              transition: "transform 0.2s ease",
                              display: "inline-block",
                            }}
                            aria-hidden="true"
                          >
                            ▼
                          </span>
                        </div>
                      </div>

                      {/* Judul & Subheader (Ringkasan): Selalu Ditampilkan */}
                      <div className="event-card__heading-group">
                        <h3 style={{ margin: "0 0 0.35rem", fontSize: "1.02rem", color: "var(--tinta-kota)", lineHeight: 1.38 }}>
                          {proposal.title}
                        </h3>
                        <p
                          style={{
                            margin: 0,
                            fontSize: "0.875rem",
                            color: "var(--quiet-ink)",
                            display: isExpanded ? "block" : "-webkit-box",
                            WebkitLineClamp: isExpanded ? undefined : 2,
                            WebkitBoxOrient: "vertical",
                            overflow: "hidden",
                            lineHeight: 1.45,
                          }}
                        >
                          {proposal.claims[0]?.claim_text ||
                            `Insiden kategori ${proposalCategoryLabel(proposal)} yang terdeteksi di wilayah ${proposal.location_label || "DKI Jakarta"}.`}
                        </p>
                      </div>

                      {/* Hint Jika Belum Diperluas (Collapsible Hint) */}
                      {!isExpanded && (
                        <div className="event-card__collapse-indicator">
                          <span>📍 Klik untuk melihat rincian &amp; lokasi peta</span>
                          <span>▼ Detail</span>
                        </div>
                      )}

                      {/* Bagian Diperluas (Extended Body): Hanya Muncul Saat Kartu Ditekan */}
                      {isExpanded && (
                        <div className="event-card__collapse-body">
                          <dl className="event-card__facts" style={{ margin: "0.75rem 0" }}>
                            <div>
                              <dt>Kategori</dt>
                              <dd>{proposalCategoryLabel(proposal)}</dd>
                            </div>
                            <div>
                              <dt>Tingkat Dampak</dt>
                              <dd>{severityLabel(proposal.severity)}</dd>
                            </div>
                            <div>
                              <dt>Lokasi</dt>
                              <dd>{proposal.location_label || "DKI Jakarta"}</dd>
                            </div>
                            <div>
                              <dt>Sumber</dt>
                              <dd style={{ color: isMulti ? "#15803d" : undefined }}>
                                {typeof proposal.source_count === "number" ? `Dilaporkan oleh ${proposal.source_count} media` : "Sumber tidak diketahui"}
                              </dd>
                            </div>
                            <div>
                              <dt>Waktu Kejadian</dt>
                              <dd>{proposal.event_time.value ? formatInstant(proposal.event_time.value) : "Waktu belum ditentukan"}</dd>
                            </div>
                            <div>
                              <dt>Grounding Bukti</dt>
                              <dd>{proposal.claims.length} klaim kutipan</dd>
                            </div>
                          </dl>

                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "center",
                              marginTop: "0.75rem",
                              paddingTop: "0.6rem",
                              borderTop: "1px dashed var(--beton)",
                            }}
                          >
                            <button
                              type="button"
                              className="text-link"
                              style={{
                                background: "transparent",
                                border: "none",
                                padding: 0,
                                cursor: "pointer",
                                fontSize: "0.85rem",
                                fontWeight: 700,
                                color: isSelected ? "var(--kali-teal)" : "var(--tinta-kota)",
                              }}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleSelectProposal(proposal, true);
                              }}
                            >
                              {isSelected ? "📍 Sedang Ditampilkan di Peta" : "📍 Pusatkan di Peta"}
                            </button>
                            <button
                              type="button"
                              style={{
                                background: "transparent",
                                border: "none",
                                padding: 0,
                                cursor: "pointer",
                                color: "var(--kali-teal)",
                                fontSize: "0.85rem",
                                fontWeight: 600,
                              }}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleSelectProposal(proposal, false);
                                setShowEvidenceModal(true);
                              }}
                            >
                              Buka detail record API →
                            </button>
                          </div>
                        </div>
                      )}
                    </article>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      {/* ============================================================== */}
      {/* 6. MODAL BUKTI BERITA & GROUNDING (KHUSUS PUBLIK, TANPA AKSI MODERATOR) */}
      {/* ============================================================== */}
      {showEvidenceModal && selectedProposal && (
        <div
          className="evidence-modal-backdrop"
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(15, 23, 42, 0.65)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
            padding: "1rem",
            backdropFilter: "blur(2px)",
          }}
          onClick={() => setShowEvidenceModal(false)}
        >
          <div
            className="evidence-modal-content"
            style={{
              background: "var(--surface)",
              borderRadius: "12px",
              maxWidth: "780px",
              width: "100%",
              maxHeight: "88vh",
              overflowY: "auto",
              padding: "1.75rem",
              boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
              border: "1px solid var(--beton)",
            }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-incident-title"
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "1rem", borderBottom: "1px solid var(--beton)", paddingBottom: "0.75rem" }}>
              <div>
                <span style={{ fontSize: "0.78rem", fontWeight: 700, color: "#166534", textTransform: "uppercase", letterSpacing: "0.04em", display: "block" }}>
                  Sumber tiap klaim
                </span>
                <h2 id="modal-incident-title" style={{ margin: "0.25rem 0", fontSize: "1.25rem", color: "var(--tinta-kota)" }}>
                  {selectedProposal.title}
                </h2>
                <p style={{ margin: 0, fontSize: "0.85rem", color: "var(--quiet-ink)" }}>
                  Lokasi: <strong>{selectedProposal.location_label || "DKI Jakarta"}</strong> · Koordinat: <strong>{selectedProposal.coordinates ? `${selectedProposal.coordinates[0].toFixed(4)}, ${selectedProposal.coordinates[1].toFixed(4)}` : "Tercatat"}</strong>
                </p>
              </div>
              <button
                type="button"
                className="feedback-dismiss"
                onClick={() => setShowEvidenceModal(false)}
                aria-label="Tutup jendela bukti"
                style={{ fontSize: "1.5rem", background: "transparent", border: "none", cursor: "pointer", padding: "0.25rem 0.5rem" }}
              >
                ×
              </button>
            </div>

            {/* Klaim & Grounding Kutipan Berita */}
            <section style={{ marginBottom: "1.5rem" }}>
              <h3 style={{ fontSize: "1rem", color: "var(--tinta-kota)", marginBottom: "0.6rem" }}>
                Klaim ({selectedProposal.claims.length})
              </h3>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.65rem" }}>
                {selectedProposal.claims.map((claim, idx) => (
                  <div
                    key={claim.claim_id || `claim-${idx}`}
                    style={{
                      background: "#f8fafc",
                      border: "1px solid var(--beton)",
                      borderLeft: "3px solid var(--kali-teal)",
                      borderRadius: "6px",
                      padding: "0.75rem 0.9rem",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.35rem" }}>
                      <span style={{ fontSize: "0.75rem", fontWeight: 700, color: "var(--kali-teal)" }}>
                        Fakta #{idx + 1}
                      </span>
                    </div>
                    <p style={{ margin: "0 0 0.4rem", fontWeight: 600, fontSize: "0.92rem", color: "var(--tinta-kota)" }}>
                      {claim.claim_text}
                    </p>
                    {claim.source_url && (
                      <p style={{ margin: "0 0 0.4rem", fontSize: "0.82rem", color: "var(--quiet-ink)" }}>
                        Sumber: <a href={claim.source_url} target="_blank" rel="noopener noreferrer">{claim.outlet ?? "Sumber"}</a>
                      </p>
                    )}
                    {claim.quote_text && (
                      <blockquote style={{ margin: 0, fontSize: "0.84rem", fontStyle: "italic", color: "var(--quiet-ink)", background: "#ffffff", padding: "0.45rem 0.65rem", borderRadius: "4px", border: "1px solid #e2e8f0" }}>
                        "{claim.quote_text}"
                      </blockquote>
                    )}
                  </div>
                ))}
              </div>
            </section>

            {/* Teks Berita Sumber Asli (Verbatim Chunks) */}
            <section>
              <h3 style={{ fontSize: "1rem", color: "var(--tinta-kota)", marginBottom: "0.6rem" }}>
                Kutipan Berita Asli (Grounding Verbatim)
              </h3>
              {relevantChunks.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                  {relevantChunks.map((chunk, cIdx) => (
                    <article
                      key={`chunk-${chunk.chunk_index ?? cIdx}`}
                      style={{
                        background: "#fafafa",
                        border: "1px solid var(--beton)",
                        borderRadius: "6px",
                        padding: "0.85rem",
                        fontSize: "0.875rem",
                        lineHeight: 1.6,
                      }}
                    >
                      <span style={{ fontSize: "0.72rem", color: "var(--quiet-ink)", textTransform: "uppercase", display: "block", marginBottom: "0.4rem" }}>
                        Fragmen Berita #{chunk.chunk_index + 1}
                      </span>
                      <div style={{ whiteSpace: "pre-wrap", color: "var(--tinta-kota)" }}>
                        {renderHighlightedText(chunk.text, currentQuotes)}
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <p style={{ fontSize: "0.875rem", color: "var(--quiet-ink)", fontStyle: "italic" }}>
                  Kutipan teks sumber tidak tersedia pada halaman publik ini. Klik nama sumber pada klaim untuk membaca beritanya.
                </p>
              )}
            </section>

            <div style={{ marginTop: "1.5rem", textAlign: "right" }}>
              <button
                type="button"
                className="button button--primary"
                onClick={() => setShowEvidenceModal(false)}
                style={{ padding: "0.5rem 1.25rem", borderRadius: "6px" }}
              >
                Tutup
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

export { LaporanPublik as LaporanPublikDemo };

