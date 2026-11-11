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


// Browser-only, like the other page stylesheets. The page carries its own styles and does not
// depend on moderator-review.css (UI-SYSTEM-02).
if (typeof document !== "undefined") {
  void import("./laporan-publik.css");
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

/** Badge variant: AI summaries are informational, moderator-reviewed versions use the accent tone. */
export function publicationBadgeClass(proposal: EventProposalDto): string {
  return proposal.publication_mode === "moderator_reviewed" ? "badge badge--accent" : "badge badge--info";
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

  const filterButton = (value: string, label: string) => (
    <button
      type="button"
      className="filter-pill"
      aria-pressed={categoryFilter === value}
      onClick={() => setCategoryFilter(value)}
    >
      {label}
    </button>
  );

  return (
    <main id="main-content" className="main-shell">
      {/* 1. Header Halaman: judul, lalu penjelasan asal dan proses penerbitan */}
      <section className="laporan-intro-section" aria-labelledby="discover-title">
        <h1 id="discover-title">Laporan Publik</h1>
        <p className="laporan-intro-copy">
          Ringkasan insiden yang diterbitkan dari berita dan laporan sumber yang disebutkan. Setiap laporan disusun otomatis
          oleh agen AI dari sumber-sumbernya, lalu terbit setelah lolos pemeriksaan aturan otomatis atau setelah ditinjau
          moderator. Setiap klaim menautkan sumbernya. Jumlah media yang melaporkan menunjukkan banyaknya sumber, bukan
          kepastian kejadian. Peta hanya menampilkan titik yang dikembalikan sumber dan fasilitas darurat terdekat.
        </p>
      </section>

      <hr/>

      {errorMessage && (
        <div className="feedback-banner feedback-banner--error" role="alert">
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

      {/* 3. Kontrol pencarian dan filter kategori */}
      <section className="laporan-controls" aria-label="Pencarian dan filter daftar laporan">
        <div className="field">
          <label className="field__label" htmlFor="event-search">
            Cari dalam daftar API yang dimuat
          </label>
          <div className="laporan-search">
            <span aria-hidden="true" className="laporan-search__glyph">⌕</span>
            <input
              autoComplete="off"
              id="event-search"
              name="q"
              type="search"
              className="laporan-search__input"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Contoh: jambret, banjir di Jakarta, kebakaran, kecelakaan…"
            />
            {searchQuery.length > 0 && (
              <button className="text-link laporan-search__clear" type="button" onClick={() => setSearchQuery("")}>
                Hapus
              </button>
            )}
          </div>
        </div>

        <div className="laporan-filters" role="group" aria-label="Filter kategori laporan">
          {filterButton("all", `Semua (${proposals.length})`)}
          {multiSourceCount > 0 && filterButton("multi_source", `Dilaporkan oleh 2+ media (${multiSourceCount})`)}
          {filterButton("flood", "🌊 Banjir & Cuaca")}
          {filterButton("fire", "🔥 Kebakaran & Bahaya")}
          {filterButton("traffic", "🚗 Transportasi & Lalin")}
          {filterButton("security", "🚨 Keamanan & Kriminalitas")}
          {filterButton("other", "📋 Kategori Lainnya")}
          {(categoryFilter !== "all" || searchQuery.length > 0) && (
            <button
              type="button"
              className="filter-pill laporan-filter-clear"
              onClick={() => {
                setCategoryFilter("all");
                setSearchQuery("");
              }}
            >
              ✕ Reset Filter
            </button>
          )}
        </div>

        <p className="laporan-filter-note muted">
          Pencarian dan filter berlaku pada {filteredProposals.length} record yang sudah dimuat dari katalog ini.
        </p>
      </section>

      {/* Grid Vertikal: Peta di Atas, Daftar Record di Bawah */}
      <div className="discovery-grid">
        {/* ============================================================== */}
        {/* 4. PETA DI ATAS (MAP ABOVE): Menggunakan InteractiveIncidentMap */}
        {/* ============================================================== */}
        <div className="map-column" ref={mapSectionRef}>
          <section className="map-panel laporan-map-panel" aria-labelledby="map-title">
            <header className="panel-heading map-panel__heading laporan-map-header">
              <div>
                <p className="section-kicker">Geometri Spasial &amp; Fasilitas Sekitar dari Respons API</p>
                <h2 id="map-title" className="laporan-heading">
                  Peta Koordinat Interaktif
                </h2>
              </div>
              <div className="laporan-map-chips">
                <span className="badge badge--info">Tile OSM Interaktif</span>
                <span className="badge">Fasilitas sekitar</span>
              </div>
            </header>

            <p className="map-panel__intro laporan-map-intro">
              Hanya geometri yang dikembalikan API untuk laporan terbit yang ditampilkan. Klik tombol fasilitas (RS, Polisi, Damkar) untuk melihat sebaran pos darurat di sekitar insiden.
            </p>

            {/* Peta Interaktif OSM */}
            <div className="laporan-map-stage">
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

            {/* Panel ringkasan insiden yang sedang dipetakan */}
            {selectedProposal && (
              <div className="map-caption laporan-map-caption">
                <div className="laporan-caption-row">
                  <div className="laporan-caption-title">
                    <span className="eyebrow laporan-caption-eyebrow">Insiden Terpilih di Peta</span>
                    <strong className="laporan-caption-heading">
                      {selectedProposal.title}
                    </strong>
                  </div>
                  <button
                    type="button"
                    className="button button--quiet laporan-evidence-button"
                    onClick={() => setShowEvidenceModal(true)}
                  >
                    <span aria-hidden="true">📄</span>
                    <strong>Buka Kutipan Bukti ({selectedProposal.claims.length} Klaim)</strong>
                  </button>
                </div>

                <dl className="coordinate-row laporan-facts">
                  <div>
                    <dt>Koordinat CRS84</dt>
                    <dd>
                      {selectedProposal.coordinates
                        ? `${selectedProposal.coordinates[0].toFixed(4)}, ${selectedProposal.coordinates[1].toFixed(4)}`
                        : "Tidak tercatat"}
                    </dd>
                  </div>
                  <div>
                    <dt>Wilayah Kejadian</dt>
                    <dd>{selectedProposal.location_label || "DKI Jakarta"}</dd>
                  </div>
                  <div>
                    <dt>Cara Penerbitan</dt>
                    <dd>
                      {publicationBadgeText(selectedProposal)}
                    </dd>
                  </div>
                  {selectedProposal.claims.some((claim) => claim.source_url) && (
                    <div>
                      <dt>Sumber laporan</dt>
                      <dd>
                        <ul className="laporan-source-list">
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
                    <dt>Tingkat Dampak</dt>
                    <dd>{severityLabel(selectedProposal.severity)}</dd>
                  </div>
                </dl>
              </div>
            )}
          </section>
        </div>

        {/* ============================================================== */}
        {/* 5. DAFTAR RECORD DI BAWAH (THE RECORD LIST BELOW)               */}
        {/* ============================================================== */}
        <section className="feed-panel laporan-feed-panel" aria-labelledby="feed-title">
          <header className="panel-heading">
            <div>
              <p className="section-kicker">Halaman data dari API</p>
              <h2 id="feed-title" className="laporan-heading">Daftar record</h2>
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
              <span>Menyiapkan daftar laporan yang diterbitkan.</span>
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

                return (
                  <li key={proposal.proposal_id}>
                    <article
                      className={`card card--interactive event-card event-card--collapsible laporan-event-card${
                        isSelected ? " event-card--selected" : ""
                      }`}
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
                      <div className="event-card__topline">
                        <span className={`event-card__dataset-label ${publicationBadgeClass(proposal)}`}>
                          {publicationBadgeText(proposal)}
                        </span>
                        <div className="laporan-card-meta">
                          <span className="event-card__version">v{proposal.schema_version}</span>
                          <span
                            className={`laporan-chevron${isExpanded ? " laporan-chevron--open" : ""}${
                              isSelected ? " laporan-chevron--selected" : ""
                            }`}
                            aria-hidden="true"
                          >
                            ▼
                          </span>
                        </div>
                      </div>

                      {/* Judul & Subheader (Ringkasan): Selalu Ditampilkan */}
                      <div className="event-card__heading-group">
                        <h3 className="laporan-event-title">
                          {proposal.title}
                        </h3>
                        <p
                          className={`laporan-event-summary${isExpanded ? "" : " laporan-event-summary--clamped"}`}
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
                          <dl className="event-card__facts laporan-event-facts">
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
                              <dd>
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

                          <div className="laporan-card-actions">
                            <button
                              type="button"
                              className={`button button--quiet laporan-card-action${
                                isSelected ? " laporan-card-action--current" : ""
                              }`}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleSelectProposal(proposal, true);
                              }}
                            >
                              {isSelected ? "📍 Sedang Ditampilkan di Peta" : "📍 Pusatkan di Peta"}
                            </button>
                            <button
                              type="button"
                              className="button button--quiet laporan-card-action laporan-card-action--detail"
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
          className="modal-backdrop laporan-modal-backdrop"
          onClick={() => setShowEvidenceModal(false)}
        >
          <div
            className="modal-dialog laporan-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-incident-title"
          >
            <div className="laporan-modal-header">
              <div>
                <span className="eyebrow laporan-modal-eyebrow">Sumber tiap klaim</span>
                <h2 id="modal-incident-title" className="laporan-modal-title">
                  {selectedProposal.title}
                </h2>
                <p className="laporan-modal-meta muted">
                  Lokasi: <strong>{selectedProposal.location_label || "DKI Jakarta"}</strong> · Koordinat: <strong>{selectedProposal.coordinates ? `${selectedProposal.coordinates[0].toFixed(4)}, ${selectedProposal.coordinates[1].toFixed(4)}` : "Tercatat"}</strong>
                </p>
              </div>
              <button
                type="button"
                className="button button--quiet laporan-modal-close"
                onClick={() => setShowEvidenceModal(false)}
                aria-label="Tutup jendela bukti"
              >
                ×
              </button>
            </div>

            {/* Klaim & Grounding Kutipan Berita */}
            <section className="laporan-modal-section">
              <h3 className="laporan-modal-heading">
                Klaim ({selectedProposal.claims.length})
              </h3>
              <div className="laporan-stack">
                {selectedProposal.claims.map((claim, idx) => (
                  <div key={claim.claim_id || `claim-${idx}`} className="card laporan-claim">
                    <div className="laporan-claim__top">
                      <span className="eyebrow">
                        Fakta #{idx + 1}
                      </span>
                    </div>
                    <p className="laporan-claim__text">
                      {claim.claim_text}
                    </p>
                    {claim.source_url && (
                      <p className="laporan-claim__source">
                        Sumber: <a href={claim.source_url} target="_blank" rel="noopener noreferrer">{claim.outlet ?? "Sumber"}</a>
                      </p>
                    )}
                    {claim.quote_text && (
                      <blockquote className="laporan-quote">
                        "{claim.quote_text}"
                      </blockquote>
                    )}
                  </div>
                ))}
              </div>
            </section>

            {/* Teks Berita Sumber Asli (Verbatim Chunks) */}
            <section className="laporan-modal-section">
              <h3 className="laporan-modal-heading">
                Kutipan Berita Asli (Grounding Verbatim)
              </h3>
              {relevantChunks.length > 0 ? (
                <div className="laporan-stack">
                  {relevantChunks.map((chunk, cIdx) => (
                    <article key={`chunk-${chunk.chunk_index ?? cIdx}`} className="card laporan-chunk">
                      <span className="laporan-chunk__label">
                        Fragmen Berita #{chunk.chunk_index + 1}
                      </span>
                      <div className="laporan-chunk__text">
                        {renderHighlightedText(chunk.text, currentQuotes)}
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="laporan-empty-note">
                  Kutipan teks sumber tidak tersedia pada halaman publik ini. Klik nama sumber pada klaim untuk membaca beritanya.
                </p>
              )}
            </section>

            <div className="laporan-modal-footer">
              <button
                type="button"
                className="button button--primary"
                onClick={() => setShowEvidenceModal(false)}
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
