import assert from "node:assert/strict";
import test from "node:test";
import type { EventProposalDto } from "../src/layers/l4-application-integration/moderation-api.js";
import { distinctOutlets } from "../src/layers/l4-application-integration/proposal-publication.js";
import {
  assessProposalSourceGate,
  evaluateAutoPublication,
  SOURCE_PERMISSION_WAIVED_LOCAL,
} from "../src/layers/l4-application-integration/publication-policy.js";
import { countPublicationOutlets, type OutletClaim } from "../src/layers/l4-application-integration/publication-source-count.js";

/**
 * HOSTED-28 (owner decision, 18 Nov 2026; F-09). Two rules, both pure (no database):
 * - source_count is the number of distinct outlets. A syndicated copy is not counted.
 * - a claim from a revoked source is refused with `source_revoked`, and local_relaxed never waives it.
 *
 * OUTLET_CASES is also checked against countIndependentSources in apps/web/src/published-events.ts. The web copy is
 * not imported here (the worker must not import web code). Each case gives the same outlets and copies in both.
 */

const LINK = "https://news.example/berita";

function link(outlet: string | null, text: string | null, sourceUrl: string | null = LINK): OutletClaim {
  return { outlet, claim_text: text, quote_text: null, source_url: sourceUrl };
}

export const OUTLET_CASES: ReadonlyArray<{ name: string; claims: OutletClaim[]; outlets: number; copies: number }> = [
  {
    name: "two outlets reporting different facts are two outlets",
    claims: [link("Kompas", "Banjir 50 cm di Cawang"), link("Detik", "Pohon tumbang di Kebayoran")],
    outlets: 2,
    copies: 0,
  },
  {
    name: "an outlet repeating a title an earlier outlet carried is a copy",
    claims: [link("Kompas", "Banjir di Cawang"), link("Detik", "Banjir di Cawang")],
    outlets: 1,
    copies: 1,
  },
  {
    name: "the copy is the same whatever the claim order",
    claims: [link("Detik", "Banjir di Cawang"), link("Kompas", "Banjir di Cawang")],
    outlets: 1,
    copies: 1,
  },
  {
    name: "case, punctuation and spacing do not separate a copy",
    claims: [link("Antara", "Banjir, di Cawang!"), link("Tempo", "  banjir   di cawang ")],
    outlets: 1,
    copies: 1,
  },
  {
    name: "one outlet with several claims is one outlet",
    claims: [link("Kompas", "Banjir di Cawang"), link("Kompas", "Pohon tumbang")],
    outlets: 1,
    copies: 0,
  },
  {
    name: "the outlet that carries the most titles is visited first, so a fully covered outlet is the copy",
    claims: [
      link("Kompas", "Banjir di Cawang"),
      link("Detik", "Banjir di Cawang"),
      link("Detik", "Pohon tumbang"),
    ],
    outlets: 1,
    copies: 1,
  },
  {
    name: "an outlet with a title no earlier outlet carried is not a copy",
    claims: [
      link("Antara", "Banjir di Cawang"),
      link("Antara", "Hujan deras di Cawang"),
      link("Tempo", "Banjir di Cawang"),
      link("Tempo", "Air sungai meluap"),
    ],
    outlets: 2,
    copies: 0,
  },
  {
    name: "an outlet whose claim has no usable title is never a copy",
    claims: [link("Kompas", "Banjir di Cawang"), link("Detik", "")],
    outlets: 2,
    copies: 0,
  },
  {
    name: "the claim text placeholder is never a title",
    claims: [link("Kompas", "Klaim laporan"), link("Detik", "Klaim laporan")],
    outlets: 2,
    copies: 0,
  },
  {
    name: "a quote stands in for a missing claim text",
    claims: [
      { outlet: "Kompas", claim_text: "", quote_text: "Banjir di Cawang", source_url: LINK },
      link("Detik", "Banjir di Cawang"),
    ],
    outlets: 1,
    copies: 1,
  },
  {
    name: "three outlets: one repeated title is one copy, a new title is another outlet",
    claims: [link("Kompas", "Banjir di Cawang"), link("Detik", "Banjir di Cawang"), link("Antara", "Pohon tumbang")],
    outlets: 2,
    copies: 1,
  },
  {
    name: "a claim without a source link does not count",
    claims: [link("Kompas", "Banjir", null), link("Detik", "Banjir", "")],
    outlets: 0,
    copies: 0,
  },
  {
    name: "a link with no outlet name counts as one unnamed outlet",
    claims: [link(null, "Banjir di Cawang"), link("", "Pohon tumbang")],
    outlets: 1,
    copies: 0,
  },
  {
    name: "a blank outlet name is skipped",
    claims: [link("   ", "Banjir di Cawang")],
    outlets: 0,
    copies: 0,
  },
  {
    name: "no claims means no outlets",
    claims: [],
    outlets: 0,
    copies: 0,
  },
];

test("HOSTED-28 outlet count: every fixture case gives the expected outlets and copies", () => {
  for (const item of OUTLET_CASES) {
    assert.deepEqual(
      countPublicationOutlets(item.claims),
      { outlets: item.outlets, copies: item.copies },
      item.name,
    );
  }
});

test("HOSTED-28 outlet count: outlets plus copies is the number of named outlets, and copies never add to the count", () => {
  const claims = [link("Kompas", "Banjir di Cawang"), link("Detik", "Banjir di Cawang"), link("Antara", "Pohon tumbang")];
  const result = countPublicationOutlets(claims);
  assert.equal(result.outlets + result.copies, 3);
  assert.equal(result.outlets, 2, "the copy is not counted");
});

test("HOSTED-28 publication source_count: distinctOutlets reads the outlet rule, not the number of registry sources", () => {
  // Two registry sources, one outlet name, one repeated title: the old rule counted 2; the outlet rule counts 1.
  const twoFeedsOneOutlet = {
    claims: [
      { claim_id: "c1", source_id: "source-kompas-nasional", outlet: "Kompas", claim_text: "Banjir di Cawang", quote_text: "", source_url: LINK },
      { claim_id: "c2", source_id: "source-kompas-megapolitan", outlet: "Kompas", claim_text: "Banjir di Cawang", quote_text: "", source_url: LINK },
    ],
  } as unknown as EventProposalDto;
  assert.equal(distinctOutlets(twoFeedsOneOutlet), 1);

  const twoOutlets = {
    claims: [
      { claim_id: "c1", source_id: "source-kompas", outlet: "Kompas", claim_text: "Banjir di Cawang", quote_text: "", source_url: LINK },
      { claim_id: "c2", source_id: "source-detik", outlet: "Detik", claim_text: "Pohon tumbang", quote_text: "", source_url: LINK },
    ],
  } as unknown as EventProposalDto;
  assert.equal(distinctOutlets(twoOutlets), 2);
});

// --- Revoked sources ------------------------------------------------------------------------------------------------

const REVOKED = "source-revoked-outlet";

function proposalFrom(sourceId: string) {
  return {
    schema_version: "2.0",
    proposal_id: "prop-hosted28-1",
    incident_id: "inc-hosted28-1",
    title: "Banjir di Cawang",
    incident_type: "genangan_air_luapan_saluran",
    primary_category: "disasters_weather",
    severity: "medium",
    event_time: { precision: "exact", value: "2026-11-10T08:00:00.000Z" },
    location_label: "Cawang, Jakarta Timur",
    coordinates: null,
    claims: [{
      claim_id: "claim-1",
      claim_text: "Genangan 50 cm di Cawang",
      evidence_label: "attributed_report",
      support_assessment: "supported",
      quote_text: "Genangan setinggi 50 cm",
      evidence_ref_id: "chk-1",
      source_id: sourceId,
      outlet: "Fictional outlet",
      source_url: LINK,
    }],
    impacts: [],
    caveats: [],
    has_discrepancy: false,
    discrepancy_summary: null,
    discrepancies: [],
    correlation_relationship: "primary_initial",
    is_multi_source: false,
    source_count: 1,
    source_id: sourceId,
    proposed_at: "2026-11-10T08:05:00.000Z",
  };
}

test("HOSTED-28 gate: a revoked source is refused as source_revoked even under local_relaxed, with no waiver recorded", () => {
  const assessment = evaluateAutoPublication(proposalFrom(REVOKED), {
    publicDisplaySourceIds: new Set(),
    revokedSourceIds: new Set([REVOKED]),
    sourcePermission: "local_relaxed",
  });
  assert.deepEqual(assessment.reasons, ["source_revoked"]);
  assert.deepEqual(assessment.waivers, []);
});

test("HOSTED-28 gate: a revoked source is refused as source_revoked under the required check too, and not as source_rights_missing", () => {
  const reasons = evaluateAutoPublication(proposalFrom(REVOKED), {
    publicDisplaySourceIds: new Set(),
    revokedSourceIds: new Set([REVOKED]),
    sourcePermission: "required",
  }).reasons;
  assert.deepEqual(reasons, ["source_revoked"]);
});

test("HOSTED-28 gate: the moderator source gate refuses a revoked source as source_revoked, with no waiver", () => {
  const reasons = assessProposalSourceGate(proposalFrom(REVOKED), {
    publicDisplaySourceIds: new Set(),
    revokedSourceIds: new Set([REVOKED]),
  });
  assert.deepEqual(reasons, ["source_revoked"]);
});

test("HOSTED-28 gate: a source that is merely unregistered still gets the local_relaxed waiver", () => {
  const assessment = evaluateAutoPublication(proposalFrom("source-unregistered-outlet"), {
    publicDisplaySourceIds: new Set(),
    revokedSourceIds: new Set([REVOKED]),
    sourcePermission: "local_relaxed",
  });
  assert.deepEqual(assessment.reasons, []);
  assert.deepEqual(assessment.waivers, [SOURCE_PERMISSION_WAIVED_LOCAL]);
});

test("HOSTED-28 gate: with no revoked set supplied, the waiver rule is unchanged", () => {
  const assessment = evaluateAutoPublication(proposalFrom(REVOKED), {
    publicDisplaySourceIds: new Set(),
    sourcePermission: "local_relaxed",
  });
  assert.deepEqual(assessment.reasons, []);
  assert.deepEqual(assessment.waivers, [SOURCE_PERMISSION_WAIVED_LOCAL]);
});
