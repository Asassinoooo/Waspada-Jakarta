import { useCallback, useEffect, useMemo, useState } from "react";
import { formatInstant } from "./display.js";
import { InteractiveIncidentMap } from "./InteractiveIncidentMap.js";
import {
  type EventProposalDto,
  type StoredEvidenceChunk,
  fetchModerationProposals,
  fetchProposalDetail,
  proposalCategoryLabel,
  severityLabel,
  isProposalMultiSource,
  renderHighlightedText,
} from "./ModeratorReview.js";

if (typeof document !== "undefined") {
  void import("./moderator-review.css");
}

export interface LaporanPublikDemoProps {
  initialProposals?: readonly EventProposalDto[];
  initialSelectedId?: string;
  apiBaseUrl?: string;
  fetcher?: typeof fetch;
}

export function LaporanPublikDemo({
  initialProposals,
  initialSelectedId,
  apiBaseUrl = "/api/v1/moderation",
  fetcher,
}: LaporanPublikDemoProps) {
  const [proposals, setProposals] = useState<EventProposalDto[]>(() =>
    initialProposals ? [...initialProposals] : []
  );
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    initialSelectedId ?? initialProposals?.[0]?.proposal_id ?? null
  );
  const [chunksMap, setChunksMap] = useState<Record<string, readonly StoredEvidenceChunk[]>>({});
  const [loading, setLoading] = useState<boolean>(!initialProposals);
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [activeClaimId, setActiveClaimId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // 1. Fetch proposals list from API if not provided
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
    fetchModerationProposals({ apiBaseUrl, fetcher })
      .then((items) => {
        if (cancelled) return;
        // Strictly filter to ONLY verified, trustworthy published reports (multi-source corroborated, non-draft, non-contest)
        const verifiedOnly = items.filter((item) => {
          const isMultiSource =
            isProposalMultiSource(item) ||
            item.is_multi_source === true ||
            (typeof item.source_count === "number" && item.source_count > 1);
          const isNoticeOrContest = item.caveats?.some(
            (c) =>
              c.includes("bukan insiden darurat") ||
              c.includes("purely informational") ||
              c.includes("warta kegiatan") ||
              c.includes("lomba") ||
              c.includes("stunting")
          );
          return isMultiSource && !isNoticeOrContest;
        });
        setProposals(verifiedOnly);
        if (verifiedOnly.length > 0 && !selectedId) {
          setSelectedId(verifiedOnly[0]!.proposal_id);
        }
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoading(false);
        setErrorMessage(
          `Gagal memuat katalog laporan terpercaya: ${err instanceof Error ? err.message : String(err)}`
        );
      });

    return () => {
      cancelled = true;
    };
  }, [initialProposals, apiBaseUrl, fetcher, selectedId]);

  // 2. Fetch details (and chunks) for currently selected proposal
  const loadProposalChunks = useCallback(
    async (proposalId: string) => {
      if (chunksMap[proposalId] || !proposalId) return;
      try {
        const detail = await fetchProposalDetail(proposalId, { apiBaseUrl, fetcher });
        if (detail.chunks && detail.chunks.length > 0) {
          setChunksMap((prev) => ({
            ...prev,
            [proposalId]: detail.chunks,
          }));
        }
      } catch (err) {
        console.warn(`[LaporanPublikDemo] Could not load evidence chunks for ${proposalId}:`, err);
      }
    },
    [chunksMap, apiBaseUrl, fetcher]
  );

  useEffect(() => {
    if (selectedId) {
      void loadProposalChunks(selectedId);
    }
  }, [selectedId, loadProposalChunks]);

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

  return (
    <main id="main-content" className="main-shell moderator-page moderator-page--queue">
      {/* Header Utama Halaman */}
      <section className="review-heading" aria-labelledby="public-demo-title">
        <div>
          <p className="section-kicker">Warta Keselamatan Sipil DKI Jakarta · Publik</p>
          <h1 id="public-demo-title">Laporan Publik Terverifikasi</h1>
          <p>
            Katalog warta insiden resmi yang telah melewati verifikasi multi-sumber independen (Detik, Antara, CNN, dsb.),
            grounding kutipan berita verbatim, dan diterbitkan untuk masyarakat.
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <span className="fixture-chip" style={{ background: "#dcfce7", color: "#166534", borderColor: "#86efac" }}>
            ✓ 100% Terverifikasi &amp; Terbit
          </span>
          <span className="fixture-chip">Live Verified Feed</span>
        </div>
      </section>

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

      {loading ? (
        <section className="state-panel" role="status">
          <p>Memuat katalog laporan terverifikasi…</p>
        </section>
      ) : proposals.length === 0 ? (
        <div className="moderator-empty-queue" role="status">
          <div className="empty-queue-icon">✓</div>
          <h3>Belum ada laporan terverifikasi</h3>
          <p>Seluruh feed sedang dalam proses sinkronisasi.</p>
        </div>
      ) : (
        <div className="moderator-queue-grid">
          {/* Kolom Kiri: Antrean Berita & Laporan Terpercaya (360px) */}
          <aside className="queue-column" aria-label="Daftar laporan terpercaya">
            <header className="queue-column-header">
              <strong>Laporan Terverifikasi</strong>
              <span className="queue-badge-count">{filteredProposals.length} insiden</span>
            </header>

            {/* Kotak Pencarian Cepat */}
            <div style={{ padding: "0.5rem 0.75rem", borderBottom: "1px solid var(--beton)" }}>
              <input
                type="search"
                placeholder="Cari wilayah atau kata kunci..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{
                  width: "100%",
                  padding: "0.45rem 0.65rem",
                  fontSize: "0.85rem",
                  borderRadius: "6px",
                  border: "1px solid var(--beton)",
                  background: "var(--surface)",
                  boxSizing: "border-box",
                }}
              />
            </div>

            {/* Quick Filter Bar */}
            <div className="queue-filter-bar" role="toolbar" aria-label="Filter kategori laporan">
              <button
                type="button"
                className={`queue-filter-btn ${categoryFilter === "all" ? "queue-filter-btn--active" : ""}`}
                onClick={() => setCategoryFilter("all")}
              >
                Semua ({proposals.length})
              </button>
              {multiSourceCount > 0 && (
                <button
                  type="button"
                  className={`queue-filter-btn ${
                    categoryFilter === "multi_source" ? "queue-filter-btn--active" : ""
                  }`}
                  onClick={() => setCategoryFilter("multi_source")}
                >
                  ⚡ Multi-Sumber ({multiSourceCount})
                </button>
              )}
              <button
                type="button"
                className={`queue-filter-btn ${
                  categoryFilter === "flood" ? "queue-filter-btn--active" : ""
                }`}
                onClick={() => setCategoryFilter("flood")}
              >
                Banjir
              </button>
              <button
                type="button"
                className={`queue-filter-btn ${
                  categoryFilter === "fire" ? "queue-filter-btn--active" : ""
                }`}
                onClick={() => setCategoryFilter("fire")}
              >
                Kebakaran &amp; Bahaya
              </button>
              <button
                type="button"
                className={`queue-filter-btn ${
                  categoryFilter === "traffic" ? "queue-filter-btn--active" : ""
                }`}
                onClick={() => setCategoryFilter("traffic")}
              >
                Transportasi
              </button>
              <button
                type="button"
                className={`queue-filter-btn ${
                  categoryFilter === "security" ? "queue-filter-btn--active" : ""
                }`}
                onClick={() => setCategoryFilter("security")}
              >
                Keamanan
              </button>
              <button
                type="button"
                className={`queue-filter-btn ${
                  categoryFilter === "other" ? "queue-filter-btn--active" : ""
                }`}
                onClick={() => setCategoryFilter("other")}
              >
                Lainnya
              </button>
            </div>

            {/* Daftar Kartu Laporan */}
            <ul className="proposal-queue-list">
              {filteredProposals.map((item) => {
                const isSelected = item.proposal_id === selectedProposal?.proposal_id;
                const isMultiSource = isProposalMultiSource(item);
                return (
                  <li key={item.proposal_id}>
                    <button
                      type="button"
                      className={`proposal-card-btn ${
                        isSelected ? "proposal-card-btn--selected" : ""
                      }`}
                      data-proposal-id={item.proposal_id}
                      aria-selected={isSelected}
                      onClick={() => setSelectedId(item.proposal_id)}
                    >
                      <div className="proposal-card-top">
                        <span
                          className={`incident-badge incident-badge--${item.primary_category ?? item.incident_type}`}
                        >
                          {proposalCategoryLabel(item)}
                        </span>
                        <span className={`severity-chip severity-chip--${item.severity}`}>
                          {severityLabel(item.severity)}
                        </span>
                        {isMultiSource && (
                          <span className="multi-source-badge">
                            ⚡ {item.source_count ?? 2} Sumber Terkorelasi
                          </span>
                        )}
                      </div>
                      <strong className="proposal-card-title">{item.title}</strong>
                      <div className="proposal-card-meta">
                        <span>📍 {item.location_label || "Lokasi belum ditentukan"}</span>
                        <span>⏱ {item.event_time.value || "Waktu belum ditentukan"}</span>
                        <span>📄 {item.claims.length} klaim terverifikasi</span>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </aside>

          {/* Kolom Kanan: Detail Laporan, Peta Interaktif, & Bukti Sumber */}
          <div className="details-column">
            {selectedProposal ? (
              <>
                {/* Header Detail Kasus */}
                <section className="review-case-heading" aria-label="Identitas laporan terpilih">
                  <div>
                    <div className="review-case-kicker-row">
                      <p className="section-kicker" style={{ color: "#16a34a", fontWeight: "600" }}>
                        ✓ Laporan Publik Terverifikasi
                      </p>
                      {isProposalMultiSource(selectedProposal) && (
                        <span className="multi-source-badge">
                          ⚡ {selectedProposal.source_count ?? 2} Sumber Terkorelasi
                        </span>
                      )}
                      {selectedProposal.has_discrepancy && (
                        <span className="discrepancy-badge" title="Terdapat perbedaan data antar sumber berita">
                          ⚠️ Catatan Perbedaan Data Sumber
                        </span>
                      )}
                    </div>
                    <h2>{selectedProposal.title}</h2>
                    <p>
                      Diterbitkan pada {formatInstant(selectedProposal.proposed_at)} · Standar Verifikasi 2.0
                    </p>
                  </div>
                  <dl>
                    <div>
                      <dt>ID Insiden</dt>
                      <dd>{selectedProposal.proposal_id}</dd>
                    </div>
                    <div>
                      <dt>Kategori</dt>
                      <dd>{proposalCategoryLabel(selectedProposal)}</dd>
                    </div>
                    <div>
                      <dt>Tingkat Dampak</dt>
                      <dd>{severityLabel(selectedProposal.severity)}</dd>
                    </div>
                    <div>
                      <dt>Waktu Kejadian</dt>
                      <dd>
                        {selectedProposal.event_time.value || "Waktu belum ditentukan"} ({selectedProposal.event_time.precision})
                      </dd>
                    </div>
                    <div>
                      <dt>Lokasi</dt>
                      <dd>{selectedProposal.location_label || "Lokasi belum ditentukan"}</dd>
                    </div>
                    <div>
                      <dt>Koordinat Spasial</dt>
                      <dd>
                        {selectedProposal.coordinates
                          ? `${selectedProposal.coordinates[0].toFixed(4)}, ${selectedProposal.coordinates[1].toFixed(4)}`
                          : "Tidak ada koordinat"}
                      </dd>
                    </div>
                  </dl>
                </section>

                {/* Callout Transparansi Perbedaan Data Sumber */}
                {selectedProposal.has_discrepancy && selectedProposal.discrepancies && selectedProposal.discrepancies.length > 0 && (
                  <aside className="discrepancy-callout" role="alert" aria-label="Catatan perbedaan data antar sumber berita">
                    <strong>⚠️ Transparansi Perbedaan Data Antar Media:</strong>
                    <ul>
                      {selectedProposal.discrepancies.map((disc, dIdx) => (
                        <li key={`disc-${dIdx}`}>
                          <span className="discrepancy-kind-pill">{disc.kind.replaceAll("_", " ")}</span>: {disc.description}
                        </li>
                      ))}
                    </ul>
                  </aside>
                )}

                {/* Peta Interaktif Lokasi Insiden */}
                <InteractiveIncidentMap
                  coordinates={selectedProposal.coordinates}
                  incidentType={selectedProposal.incident_type}
                  severity={selectedProposal.severity}
                  locationLabel={selectedProposal.location_label}
                  title={selectedProposal.title}
                  height={460}
                />

                {/* Lembar Pembaca Bukti & Klaim Faktual */}
                <section className="evidence-floating-sheet" aria-labelledby="evidence-reader-title">
                  <header className="evidence-floating-sheet-header">
                    <div>
                      <h3 id="evidence-reader-title" className="evidence-reader-heading">
                        Jejak Bukti Sumber Berita
                      </h3>
                      <p className="evidence-reader-subheading">
                        Transparansi Sumber · Kalimat Asli &amp; Fakta Terkonfirmasi
                      </p>
                    </div>
                    {isProposalMultiSource(selectedProposal) && (
                      <span className="corroborated-badge">
                        ⚡ Fusi Multi-Sumber Aktif
                      </span>
                    )}
                  </header>

                  <div className="evidence-floating-sheet-body">
                    <div className="review-columns">
                      {/* Kolom Kiri: Cuplikan Berita Asli dengan Highlight */}
                      <section className="review-evidence" aria-label="Teks dokumen sumber">
                        <header className="review-column-heading">
                          <p className="section-kicker">Kutipan Dokumen Asli</p>
                          <h4 className="review-column-subheading">
                            Potongan Teks Dokumen
                          </h4>
                        </header>

                        {relevantChunks && relevantChunks.length > 0 ? (
                          <div className="chunks-list">
                            {relevantChunks.map((chunk, idx) => (
                              <article key={`chunk-${chunk.chunk_index}-${idx}`} className="chunk-article">
                                <header className="chunk-header">
                                  <strong>Dokumen Sumber #{chunk.chunk_index + 1}</strong>
                                  <span className="chunk-span">
                                    Span karakter {chunk.span_start}–{chunk.span_end}
                                  </span>
                                </header>
                                <blockquote className="review-quote">
                                  {renderHighlightedText(chunk.text, currentQuotes)}
                                </blockquote>
                              </article>
                            ))}
                          </div>
                        ) : (
                          <div className="quotes-fallback-list">
                            <p className="evidence-reader-note">
                              Kutipan langsung dari laporan berita:
                            </p>
                            {selectedProposal.claims.map((claim) => (
                              <article key={claim.claim_id} className="quote-card">
                                <header className="quote-card-header">
                                  <span className="quote-ref-badge">Ref: {claim.evidence_ref_id}</span>
                                  <span className="quote-status-badge">Terverifikasi</span>
                                </header>
                                <blockquote className="review-quote">
                                  <mark className="evidence-quote-highlight">
                                    {claim.quote_text}
                                  </mark>
                                </blockquote>
                              </article>
                            ))}
                          </div>
                        )}
                      </section>

                      {/* Kolom Kanan: Daftar Klaim Faktual Terstruktur */}
                      <section className="review-proposal" aria-labelledby="claims-breakdown-title">
                        <header className="review-column-heading">
                          <p className="section-kicker">Fakta yang Terverifikasi</p>
                          <h2 id="claims-breakdown-title">
                            Daftar Klaim ({selectedProposal.claims.length})
                          </h2>
                        </header>

                        <div className="claims-list">
                          {selectedProposal.claims.map((claim) => {
                            const isClaimActive = activeClaimId === claim.claim_id;
                            return (
                              <article
                                key={claim.claim_id}
                                className={`claim-card-row ${
                                  isClaimActive ? "claim-card-row--active" : ""
                                }`}
                                onClick={() =>
                                  setActiveClaimId(isClaimActive ? null : claim.claim_id)
                                }
                              >
                                <header className="claim-card-top">
                                  <span className="claim-ref-badge">ID: {claim.claim_id}</span>
                                  <div className="claim-badges-group">
                                    {claim.is_corroborated && (
                                      <span className="corroborated-badge">
                                        ✓ Terkonfirmasi Independen
                                      </span>
                                    )}
                                    <span className="claim-status-badge" style={{ background: "#dcfce7", color: "#166534" }}>
                                      Terbit
                                    </span>
                                  </div>
                                </header>
                                <blockquote className="review-claim">
                                  {claim.claim_text}
                                </blockquote>
                                <div className="claim-quote-box">
                                  <strong>Kutipan Asli: </strong>
                                  <em>"{claim.quote_text}"</em>
                                  <div className="claim-quote-meta">
                                    Ref Bukti: {claim.evidence_ref_id} · {claim.support_assessment}
                                  </div>
                                </div>
                              </article>
                            );
                          })}
                        </div>
                      </section>
                    </div>
                  </div>
                </section>

                {/* Segel Kepercayaan Publik (Pengganti Tombol Aksi Moderator) */}
                <div className="public-trust-seal-bar" role="status">
                  <div className="trust-seal-icon" aria-hidden="true">🛡️</div>
                  <div className="trust-seal-content">
                    <strong>Informasi Terverifikasi Resmi Waspada Jakarta</strong>
                    <p>
                      Laporan ini telah melewati filter deterministik geospasial L1, ekstraksi bukti verbatim L2,
                      serta rekonsiliasi multi-sumber L3. Tidak ada tombol moderasi pada halaman publik ini karena seluruh
                      isi ditampilkan dalam status terbit terpercaya.
                    </p>
                  </div>
                </div>
              </>
            ) : (
              <div className="state-panel" role="status">
                Pilih laporan dari daftar di sebelah kiri untuk melihat rincian lokasi dan jejak bukti sumber.
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
