import assert from "node:assert/strict";
import test from "node:test";
import {
  assessAutoPublication,
  assessProposalSourceGate,
  evaluateAutoPublication,
  looksIndonesian,
} from "../src/layers/l4-application-integration/publication-policy.js";
import {
  PublicReadModel,
  proposalToEventDetail,
  summaryFromClaimTexts,
} from "../src/layers/l4-application-integration/public-read-model.js";
import {
  projectPublicEvent,
  repairLegacyPublicText,
  repairLegacyTitle,
  type PublicProjectionLookups,
} from "../src/layers/l4-application-integration/public-projection.js";

/*
 * HOSTED-35b: published text. The summary joins claim texts cleanly, legacy text is repaired on read only, one article
 * shows once per claim, an exact time is an instant only when it is an RFC 3339 date-time, and text that is not
 * Indonesian waits for a moderator on the automatic path. Pure functions and in-memory fixtures. No database, no network.
 */

const PROCESSING_TIME = "2026-11-18T03:00:00.000Z";
const PERMITTED = { publicDisplaySourceIds: new Set(["src-example"]) };
const sourceStatus = { listPublicSourceStatus: () => [] } as never;
const HASH = "a".repeat(64);

/** Words that a legacy 120-character title is cut from: "kata00 kata01 ...". Index 119 starts a new word. */
const LEGACY_WORDS = Array.from({ length: 30 }, (_, i) => `kata${String(i).padStart(2, "0")}`);
const LEGACY_TITLE = Array.from(LEGACY_WORDS.join(" ")).slice(0, 120).join("");
const LEGACY_TITLE_REPAIRED = `${LEGACY_WORDS.slice(0, 17).join(" ")}…`;

function claim(index: number, text: string): Record<string, unknown> {
  return {
    claim_id: `claim-${index}`,
    claim_text: text,
    evidence_label: "attributed_report",
    support_assessment: "supported",
    quote_text: text,
    source_url: `https://example.invalid/berita/${index}`,
    outlet: "Contoh Berita",
    source_id: "src-example",
  };
}

function proposal(claimTexts: readonly string[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: "2.0",
    proposal_id: "prop-hosted35-001",
    title: "Banjir di Cawang",
    incident_type: "genangan_air_luapan_saluran",
    primary_category: "disasters_weather",
    severity: "medium",
    event_time: { precision: "exact", value: "2026-11-18T08:00:00+07:00" },
    location_label: "Cawang, Jakarta Timur",
    coordinates: null,
    claims: claimTexts.map((text, index) => claim(index + 1, text)),
    impacts: [],
    has_discrepancy: false,
    discrepancies: [],
    correlation_relationship: "primary_initial",
    is_multi_source: false,
    source_count: 1,
    proposed_at: PROCESSING_TIME,
    ...overrides,
  };
}

test("HOSTED-35b: the summary joins claim texts without a double period", () => {
  const detail = proposalToEventDetail(proposal([
    "Genangan 50 cm di Cawang.",
    "Banjir merendam Jalan DI Panjaitan...",
    "Lalu lintas dialihkan ke Jalan Bangka Raya…",
  ]) as never);
  assert.equal(
    detail.summary,
    "Genangan 50 cm di Cawang. Banjir merendam Jalan DI Panjaitan. Lalu lintas dialihkan ke Jalan Bangka Raya.",
  );
  assert.equal(detail.summary.includes(".."), false);
});

test("HOSTED-35b: a single claim that already ends in a period keeps one period", () => {
  assert.equal(summaryFromClaimTexts(["Genangan 50 cm di Cawang."]), "Genangan 50 cm di Cawang.");
  assert.equal(summaryFromClaimTexts(["", " ", "..."]), null, "no claim text gives no summary, so the title is used");
});

test("HOSTED-35b: a summary over 500 code points is cut at a word boundary and ends with an ellipsis", () => {
  const claims = [1, 2].map((n) =>
    Array.from({ length: 40 }, (_, i) => `kata${n}${String(i).padStart(2, "0")}`).join(" "));
  const joined = `${claims[0]}. ${claims[1]}.`;
  assert.ok(Array.from(joined).length > 500, "the premise: the full summary is longer than 500");

  const summary = summaryFromClaimTexts(claims)!;
  const points = Array.from(summary);
  assert.ok(points.length <= 500, `at most 500 code points, got ${points.length}`);
  assert.ok(points.length > 480, "the cut keeps nearly the whole budget");
  assert.equal(points.at(-1), "…");

  const body = points.slice(0, -1).join("");
  assert.ok(joined.startsWith(body), "the body is a prefix of the joined text");
  assert.match(joined.charAt(body.length), /[\s.,;:]/u, "the cut falls on a boundary, never inside a word");
  assert.match(body.split(" ").at(-1)!, /^kata[12]\d{2}$/u, "the last word is complete");
});

test("HOSTED-35b: a claim with no word boundary in range leaves the title as the summary", () => {
  const huge = "x".repeat(600);
  assert.equal(summaryFromClaimTexts([huge]), null);
  const detail = proposalToEventDetail(proposal([huge]) as never);
  assert.equal(detail.summary, detail.title, "no mid-word cut, so the title stands");
});

test("HOSTED-35b: legacy runs of two periods collapse to one, and an ellipsis or a single period is kept", () => {
  assert.equal(
    repairLegacyPublicText("Genangan 50 cm di Cawang.. Banjir merendam Jalan DI Panjaitan."),
    "Genangan 50 cm di Cawang. Banjir merendam Jalan DI Panjaitan.",
  );
  assert.equal(repairLegacyPublicText("Tiga.. dua.. satu.."), "Tiga. dua. satu.");
  assert.equal(repairLegacyPublicText("Air masuk.... Warga mengungsi."), "Air masuk. Warga mengungsi.");
  assert.equal(repairLegacyPublicText("Lalu lintas ditutup... Arus dialihkan."), "Lalu lintas ditutup... Arus dialihkan.");
  assert.equal(repairLegacyPublicText("Air surut…"), "Air surut…");
  assert.equal(repairLegacyPublicText("  Banjir di Cawang.  "), "Banjir di Cawang.", "whitespace is trimmed");
  assert.equal(repairLegacyPublicText("   "), "   ", "a text that is empty after trimming is returned unchanged");
});

test("HOSTED-35b: a legacy 120-code-point title cut mid-word is cut back to its last whitespace", () => {
  assert.equal(Array.from(LEGACY_TITLE).length, 120, "the premise: the legacy title has 120 code points");
  assert.match(LEGACY_TITLE, /\p{L}$/u, "the premise: it ends in the middle of a word");
  assert.equal(repairLegacyTitle(LEGACY_TITLE), LEGACY_TITLE_REPAIRED);
});

test("HOSTED-35b: a title is repaired only when it is 120 code points, ends in a letter, and has whitespace to cut at", () => {
  const points = Array.from(LEGACY_WORDS.join(" "));
  assert.equal(repairLegacyTitle(points.slice(0, 118).join("")), points.slice(0, 118).join(""), "118 code points is not 120");
  assert.equal(repairLegacyTitle(points.slice(0, 121).join("")), points.slice(0, 121).join(""), "121 code points is not 120");
  assert.equal(repairLegacyTitle("ab ".repeat(40)), "ab ".repeat(40).trim(), "a title ending in a space is not cut");
  assert.equal(repairLegacyTitle("a".repeat(120)), "a".repeat(120), "a title with no whitespace is not cut mid-word");
});

function liveClaim(text: string): Record<string, unknown> {
  const ref = (start: number, end: number, revision: string) => ({
    report_revision_id: revision,
    permitted_text_hash: HASH,
    span_start: start,
    span_end: end,
    offset_unit: "unicode_code_points",
    relation: "supports",
  });
  return {
    claim_id: "claim-hosted35-a",
    text,
    event_time: { start: null, end: null, precision: "unknown" },
    validity: { valid_from: null, valid_until: null },
    scope: {
      place_ids: ["place-hosted35-cawang"], service_ids: [], institution_ids: [], audience_ids: [], geometry_ids: [],
    },
    qualifiers: [],
    support: [ref(0, 10, "rev-hosted35-1"), ref(10, 20, "rev-hosted35-1"), ref(20, 30, "rev-hosted35-2")],
    contradictions: [],
    context_evidence: [],
    origin_ids: ["origin-hosted35-1"],
    evidence_label: "attributed_report",
  };
}

function liveEvent(title: string, summary: string, text: string): Record<string, unknown> {
  return {
    schema_version: "2.0",
    trace_id: "trace-hosted35-001",
    record_type: "Event",
    dataset_kind: "live",
    event_id: "event-hosted35-001",
    version: 1,
    supersedes_version: null,
    publication_status: "published",
    withdrawal_reason: null,
    withdrawn_at: null,
    publication_decision_id: "dec-hosted35-001",
    title,
    summary,
    category: "disasters_weather",
    tags: [],
    lifecycle: "ongoing",
    freshness: {
      status: "current",
      evaluated_at: "2026-11-18T03:00:00Z",
      review_due_at: null,
      basis: "fast_observation_review",
    },
    event_time: { start: "2026-11-18T01:00:00Z", end: null, precision: "exact" },
    validity: { valid_from: null, valid_until: null },
    scope: {
      place_ids: ["place-hosted35-cawang"], service_ids: [], institution_ids: [], audience_ids: [], geometry_ids: [],
    },
    claims: [liveClaim(text)],
    impact_refs: [],
    published_at: "2026-11-18T03:00:00Z",
  };
}

function attribution(
  revision: string,
  start: number,
  end: number,
  displayName: string,
  url: string,
  publishedAt: string,
): Record<string, unknown> {
  return {
    dataset_kind: "live",
    report_revision_id: revision,
    permitted_text_hash: HASH,
    span_start: start,
    span_end: end,
    offset_unit: "unicode_code_points",
    relation: "supports",
    public_use_approved: true,
    display_name: displayName,
    url,
    published_at: publishedAt,
    observed_at: null,
    retrieved_at: null,
    excerpt_public_use_approved: false,
    excerpt: null,
  };
}

test("HOSTED-35b: a claim lists one source per (url, display name), keeping the earliest, and the projection repairs legacy text", () => {
  const lookups: PublicProjectionLookups = {
    scopeNames: [{ entity_type: "place", id: "place-hosted35-cawang", display_name: "Cawang" }],
    publicAttributions: [
      // Two spans of one article, the later one listed first. The earliest attribution must be kept.
      attribution("rev-hosted35-1", 0, 10, "Contoh Berita", "https://news.example.invalid/cawang", "2026-11-18T09:00:00+07:00"),
      attribution("rev-hosted35-1", 10, 20, "Contoh Berita", "https://news.example.invalid/cawang", "2026-11-18T08:00:00+07:00"),
      attribution("rev-hosted35-2", 20, 30, "Kompas", "https://kompas.example.invalid/cawang", "2026-11-18T07:00:00+07:00"),
    ],
    impacts: [],
  };
  const view = projectPublicEvent(
    liveEvent(LEGACY_TITLE, "Genangan 50 cm.. Jalan ditutup.", "Genangan 50 cm di Cawang.."),
    lookups,
  );

  assert.equal(view.title, LEGACY_TITLE_REPAIRED, "the legacy title is repaired on read");
  assert.equal(view.summary, "Genangan 50 cm. Jalan ditutup.", "the legacy summary is repaired on read");
  assert.equal(view.claims[0]?.text, "Genangan 50 cm di Cawang.", "the legacy claim text is repaired on read");
  assert.deepEqual(view.claims[0]?.sources, [
    {
      display_name: "Contoh Berita",
      url: "https://news.example.invalid/cawang",
      published_at: "2026-11-18T08:00:00+07:00",
      observed_at: null,
      retrieved_at: null,
      excerpt: null,
    },
    {
      display_name: "Kompas",
      url: "https://kompas.example.invalid/cawang",
      published_at: "2026-11-18T07:00:00+07:00",
      observed_at: null,
      retrieved_at: null,
      excerpt: null,
    },
  ], "one article shows once, with its earliest attribution, and the source order is unchanged");
});

test("HOSTED-35b: an exact time is an instant only when it is an RFC 3339 date-time, and a calendar date is a date", () => {
  const dated = proposalToEventDetail(proposal(["Banjir di Cawang."], {
    event_time: { precision: "exact", value: "2026-11-18" },
  }) as never);
  assert.deepEqual(dated.event_time, { start: "2026-11-18", end: null, precision: "date" });
  assert.deepEqual(dated.claims[0]!.event_time, { start: "2026-11-18", end: null, precision: "date" });
  assert.deepEqual(dated.validity, { valid_from: null, valid_until: null }, "a date gives no validity start");

  const instant = proposalToEventDetail(proposal(["Banjir di Cawang."], {
    event_time: { precision: "exact", value: "2026-11-18T10:00:00+07:00" },
  }) as never);
  assert.deepEqual(instant.event_time, { start: "2026-11-18T03:00:00.000Z", end: null, precision: "exact" });

  for (const value of ["2026-11-18T10:00:00", "2026-02-31", "bukan tanggal"]) {
    const detail = proposalToEventDetail(proposal(["Banjir di Cawang."], {
      event_time: { precision: "exact", value },
    }) as never);
    assert.deepEqual(detail.event_time, { start: null, end: null, precision: "unknown" }, `${value}: no invented instant`);
  }
});

test("HOSTED-35b: looksIndonesian judges real headlines and claims, and passes short text", () => {
  assert.equal(looksIndonesian("Location and nature of the incident"), false);
  assert.equal(looksIndonesian("Emergency response deployment"), false);
  assert.equal(looksIndonesian("Kebakaran rumah di Kampung Melayu, 14 unit damkar dikerahkan"), true);
  assert.equal(looksIndonesian("Polisi menangkap tiga tersangka tawuran di Petamburan"), true);
  assert.equal(looksIndonesian("Jakarta Timur"), true, "two words are too short to judge");
  assert.equal(looksIndonesian("Fire report"), true, "two words are too short to judge");
  assert.equal(looksIndonesian("Banjir merendam Jalan DI Panjaitan"), true);
});

test("HOSTED-35b: the automatic gate holds an English claim or title for a moderator, and passes Indonesian text", () => {
  const englishClaim = proposal(["Location and nature of the incident"]);
  assert.deepEqual(assessAutoPublication(englishClaim, PERMITTED), ["language_review"]);

  const englishTitle = proposal(["Genangan 50 cm di Cawang."], { title: "Emergency response deployment" });
  assert.deepEqual(assessAutoPublication(englishTitle, PERMITTED), ["language_review"]);

  const indonesian = proposal(["Genangan 50 cm di Cawang."]);
  assert.deepEqual(assessAutoPublication(indonesian, PERMITTED), [], "an Indonesian proposal is not held");
});

test("HOSTED-35b: language_review holds the automatic path only, the way a discrepancy does, and no waiver skips it", () => {
  const englishClaim = proposal(["Location and nature of the incident"]);
  const assessment = evaluateAutoPublication(englishClaim, { ...PERMITTED, sourcePermission: "local_relaxed" });
  assert.deepEqual(assessment.reasons, ["language_review"]);
  assert.deepEqual(assessment.waivers, [], "language_review is never recorded as a waiver");

  assert.deepEqual(
    assessProposalSourceGate(englishClaim, PERMITTED),
    [],
    "the moderator publish gate does not check language, as it does not check a discrepancy",
  );
});

test("HOSTED-35b: the in-memory read model repairs legacy text on read, and the stored event keeps its own text", () => {
  PublicReadModel.clearPublishedEvents();
  try {
    // An EventDetail-shaped record, as a stored version reads back. It is not a proposal, so its text is kept as stored.
    const legacy = {
      event_id: "event-hosted35-raw-1",
      version: 1,
      title: LEGACY_TITLE,
      summary: "Genangan 50 cm.. Jalan ditutup.",
      category: "disasters_weather",
      tags: [],
      lifecycle: "ongoing",
      freshness: { status: "current", evaluated_at: "2026-11-18T03:00:00Z", review_due_at: null, basis: "fast_observation_review" },
      event_time: { start: "2026-11-18T03:00:00.000Z", end: null, precision: "exact" },
      validity: { valid_from: null, valid_until: null },
      scope: { places: ["Cawang, Jakarta Timur"], services: [], institutions: [], audiences: [] },
      claims: [{
        claim_id: "claim-raw-1",
        text: "Genangan 50 cm di Cawang..",
        event_time: { start: null, end: null, precision: "unknown" },
        validity: { valid_from: null, valid_until: null },
        scope: { places: ["Cawang, Jakarta Timur"], services: [], institutions: [], audiences: [] },
        qualifiers: [],
        evidence_label: "attributed_report",
        sources: [],
      }],
      impacts: [],
      published_at: PROCESSING_TIME,
      geometries: [{
        geometry_id: "geom-hosted35-1",
        role: "approximate_place",
        geometry: { type: "Point", coordinates: [106.87, -6.24] },
        precision_m: null,
        label: "Cawang",
      }],
      location_display: "point",
      location_label: "Cawang, Jakarta Timur",
    };
    const model = new PublicReadModel(sourceStatus, [], [legacy as never]);

    const [listed] = model.events(new URLSearchParams()).data;
    assert.equal(listed?.title, LEGACY_TITLE_REPAIRED);
    assert.equal(listed?.summary, "Genangan 50 cm. Jalan ditutup.");
    assert.equal(listed?.claims[0]?.text, "Genangan 50 cm di Cawang.");

    const detail = model.detail("event-hosted35-raw-1");
    assert.equal(detail?.summary, "Genangan 50 cm. Jalan ditutup.");

    const feature = model.geoJSON().features[0];
    assert.equal(feature?.properties.title, LEGACY_TITLE_REPAIRED);

    const [stored] = model.getPublishedEvents();
    assert.equal(stored?.title, LEGACY_TITLE, "the stored title is not rewritten");
    assert.equal(stored?.summary, "Genangan 50 cm.. Jalan ditutup.", "the stored summary is not rewritten");
  } finally {
    PublicReadModel.clearPublishedEvents();
  }
});
