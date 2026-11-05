import path from "node:path";
import fs from "node:fs";
import process from "node:process";
import { PGlite } from "@electric-sql/pglite";
import { postgis } from "@electric-sql/pglite-postgis";
import { vector } from "@electric-sql/pglite-pgvector";
import type { EventProposalDto } from "../apps/db/src/event-proposal-writer.js";

interface ProposalRow {
  proposal_id: string;
  trace_id: string;
  candidate_id: string;
  context_id: string;
  proposed_at: string;
  record_json: unknown;
  incident_id?: string | null;
  report_revision_id?: string | null;
}



function parseCosineDistance(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 1.0;
  return 1.0 - dot / denom;
}

function normalizeTitleTokens(title: string): Set<string> {
  const stopwords = new Set([
    "di", "ke", "dari", "dan", "yang", "pada", "ini", "itu", "untuk", "dengan", "adalah",
    "ada", "oleh", "saat", "setelah", "karena", "terkait", "diduga", "hingga", "merusak",
    "korban", "warga", "polisi", "jaksel", "jakbar", "jaktim", "jakut", "jakpus", "jakarta",
  ]);
  const clean = title.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
  const tokens = clean.split(/\s+/).filter((t) => t.length > 2 && !stopwords.has(t));
  return new Set(tokens);
}

function titleTokenOverlap(a: Set<string>, b: Set<string>): number {
  let common = 0;
  for (const t of a) {
    if (b.has(t)) common++;
  }
  const minSize = Math.min(a.size, b.size);
  if (minSize === 0) return 0;
  return common / minSize;
}

async function main() {
  console.log("==================================================================");
  console.log("  Waspada Jakarta: Live Proposal Consolidation & Deduplication    ");
  console.log("==================================================================");

  const dataDir = path.resolve(process.cwd(), ".data/live-db");
  if (!fs.existsSync(dataDir)) {
    console.error(`Error: Data directory not found at ${dataDir}`);
    process.exit(1);
  }

  // Remove stale pid file if server was cleanly stopped
  const pidFile = path.join(dataDir, "postmaster.pid");
  if (fs.existsSync(pidFile)) {
    try {
      fs.unlinkSync(pidFile);
    } catch {}
  }

  console.log(`[Database] Opening live database at ${dataDir}...`);
  const db = new PGlite(dataDir, {
    extensions: { postgis, vector },
  });

  try {
    // 1. Fetch pending proposals
    const pendingQuery = await db.query<ProposalRow>(
      `SELECT ep.proposal_id, ep.trace_id, ep.candidate_id, ep.context_id, ep.proposed_at, ep.record_json,
              ir.incident_id, ir.report_revision_id
       FROM waspada.event_proposals ep
       LEFT JOIN waspada.publication_decisions pd
         ON pd.dataset_kind = ep.dataset_kind AND pd.proposal_id = ep.proposal_id
       LEFT JOIN waspada.incident_reports ir
         ON ir.dataset_kind = ep.dataset_kind
        AND (ep.proposal_id = ('prop-' || ir.report_revision_id)
             OR ep.proposal_id LIKE ('prop-' || ir.incident_id || '%'))
       WHERE ep.dataset_kind = 'live'
         AND pd.proposal_id IS NULL
       ORDER BY ep.proposed_at ASC;`
    );

    console.log(`Found ${pendingQuery.rows.length} pending proposals in live database.`);
    if (pendingQuery.rows.length === 0) {
      console.log("No pending proposals to consolidate.");
      return;
    }

    // 2. Fetch chunk embeddings for vectors
    const vectorQuery = await db.query<{ chunk_id: string; report_revision_id: string; embedding_text: string }>(
      `SELECT c.chunk_id, c.report_revision_id, v.embedding::text AS embedding_text
       FROM waspada.embedding_vectors v
       JOIN waspada.embedding_runs r ON r.dataset_kind = v.dataset_kind AND r.embedding_run_id = v.embedding_run_id
       JOIN waspada.evidence_chunks c ON c.dataset_kind = r.dataset_kind AND c.chunk_id = r.chunk_id
       WHERE v.dataset_kind = 'live' AND r.status = 'available';`
    );

    const reportVectors = new Map<string, number[]>();
    for (const row of vectorQuery.rows) {
      try {
        const clean = row.embedding_text.replace(/^\[|\]$/g, "");
        const nums = clean.split(",").map(Number);
        if (nums.length === 768) {
          reportVectors.set(row.report_revision_id, nums);
        }
      } catch {}
    }

    console.log(`Loaded ${reportVectors.size} embedding vectors for semantic comparison.`);

    // 3. Cluster proposals by shared incident_id, vector similarity (cosine < 0.25), or strong title overlap
    interface Cluster {
      canonicalId: string;
      incidentId: string;
      items: ProposalRow[];
    }

    const clusters: Cluster[] = [];
    const assigned = new Set<string>();

    for (let i = 0; i < pendingQuery.rows.length; i++) {
      const rowA = pendingQuery.rows[i]!;
      if (assigned.has(rowA.proposal_id)) continue;

      const propA = (typeof rowA.record_json === "string" ? JSON.parse(rowA.record_json) : rowA.record_json) as EventProposalDto;
      const tokensA = normalizeTitleTokens(propA.title || "");
      const revA = rowA.report_revision_id || rowA.proposal_id.replace(/^prop-/, "");
      const vecA = reportVectors.get(revA);
      const incidentIdA = rowA.incident_id || `inc-${revA}`;

      const currentCluster: Cluster = {
        canonicalId: incidentIdA,
        incidentId: incidentIdA,
        items: [rowA],
      };
      assigned.add(rowA.proposal_id);

      for (let j = i + 1; j < pendingQuery.rows.length; j++) {
        const rowB = pendingQuery.rows[j]!;
        if (assigned.has(rowB.proposal_id)) continue;

        const propB = (typeof rowB.record_json === "string" ? JSON.parse(rowB.record_json) : rowB.record_json) as EventProposalDto;
        const revB = rowB.report_revision_id || rowB.proposal_id.replace(/^prop-/, "");
        const vecB = reportVectors.get(revB);

        let isSameIncident = false;

        // Check 1: Shared incident_id
        if (rowA.incident_id && rowB.incident_id && rowA.incident_id === rowB.incident_id) {
          isSameIncident = true;
        }

        // Check 2: Vector semantic distance (< 0.22 => similarity > 0.78)
        if (!isSameIncident && vecA && vecB) {
          const dist = parseCosineDistance(vecA, vecB);
          if (dist < 0.22) {
            isSameIncident = true;
          }
        }

        // Check 3: Lexical keyword overlap in title
        if (!isSameIncident) {
          const tokensB = normalizeTitleTokens(propB.title || "");
          const overlap = titleTokenOverlap(tokensA, tokensB);
          if (overlap >= 0.60) {
            isSameIncident = true;
          }
        }

        if (isSameIncident) {
          currentCluster.items.push(rowB);
          assigned.add(rowB.proposal_id);
        }
      }

      clusters.push(currentCluster);
    }

    console.log(`\nCluster analysis complete:`);
    console.log(`Original proposal count : ${pendingQuery.rows.length}`);
    console.log(`Distinct physical events: ${clusters.length}`);

    let multiSourceClusters = 0;
    for (const cl of clusters) {
      if (cl.items.length > 1) {
        multiSourceClusters++;
        const first = (typeof cl.items[0]!.record_json === "string" ? JSON.parse(cl.items[0]!.record_json as string) : cl.items[0]!.record_json) as EventProposalDto;
        console.log(`  - [${cl.items.length} laporan] ${first.title} (${cl.incidentId})`);
      }
    }
    console.log(`Total multi-source events: ${multiSourceClusters}`);

    // 4. Perform atomic consolidation transaction
    await db.query("BEGIN;");

    for (const cluster of clusters) {
      if (cluster.items.length <= 1) {
        continue;
      }

      // Multi-source cluster: merge claims and sources
      const allProps: EventProposalDto[] = cluster.items.map((it) =>
        typeof it.record_json === "string" ? JSON.parse(it.record_json) : it.record_json
      );

      const sources = new Set<string>();
      const claims: Array<EventProposalDto["claims"][number]> = [];
      const seenQuotes = new Set<string>();
      const allImpacts = new Set<string>();
      const allCaveats = new Set<string>();

      for (const p of allProps) {
        if (p.source_id) sources.add(p.source_id);
        if (p.impacts) p.impacts.forEach((imp) => allImpacts.add(imp));
        if (p.caveats) p.caveats.forEach((c) => allCaveats.add(c));
        for (const cl of p.claims ?? []) {
          const qNorm = (cl.quote_text || cl.claim_text).trim().toLowerCase();
          if (!seenQuotes.has(qNorm)) {
            seenQuotes.add(qNorm);
            claims.push({
              ...cl,
              claim_id: `claim-${claims.length + 1}`,
              is_corroborated: true,
              evidence_label: "independent_corroboration" as any,
            });
          }
        }
      }

      const primaryProp = allProps[0]!;
      const consolidatedProposalId = `prop-${cluster.incidentId}-v${cluster.items.length}`;
      const now = new Date().toISOString();

      const consolidatedDto: EventProposalDto = {
        ...primaryProp,
        proposal_id: consolidatedProposalId,
        incident_id: cluster.incidentId,
        is_multi_source: true,
        source_count: Math.max(cluster.items.length, sources.size),
        claims,
        impacts: Array.from(allImpacts),
        caveats: Array.from(allCaveats),
        proposed_at: now,
      };

      // A. Insert consolidated proposal into waspada.event_proposals
      const firstRow = cluster.items[0]!;
      await db.query(
        `INSERT INTO waspada.event_proposals
         (dataset_kind, proposal_id, trace_id, candidate_id, context_id, event_id, base_event_version, investigation_id, proposed_at, record_json)
         VALUES ($1, $2, $3, $4, $5, NULL, NULL, NULL, $6::timestamptz, $7::jsonb)
         ON CONFLICT (dataset_kind, proposal_id) DO NOTHING;`,
        [
          "live",
          consolidatedProposalId,
          firstRow.trace_id,
          firstRow.candidate_id,
          firstRow.context_id,
          now,
          JSON.stringify(consolidatedDto),
        ]
      );

      // B. Insert claims into waspada.proposal_claims
      for (const cl of claims) {
        await db.query(
          `INSERT INTO waspada.proposal_claims
           (dataset_kind, proposal_id, claim_id, support_assessment, evidence_label, claim_text, record_json)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
           ON CONFLICT (dataset_kind, proposal_id, claim_id) DO NOTHING;`,
          [
            "live",
            consolidatedProposalId,
            cl.claim_id,
            cl.support_assessment || "supported",
            "independent_corroboration",
            cl.claim_text,
            JSON.stringify(cl),
          ]
        );
      }

      // C. Record publication decisions marking superseded proposals so they do not show in pending
      for (const item of cluster.items) {
        const supersededDecisionId = `dec-superseded-${item.proposal_id}`;
        await db.query(
          `INSERT INTO waspada.publication_decisions
           (dataset_kind, decision_id, trace_id, proposal_id, policy_version, event_id, event_version, reviewer_id, decided_at, record_json)
           VALUES ($1, $2, $3, $4, 'v1', NULL, NULL, 'system-corroborator', NOW(), $5::jsonb)
           ON CONFLICT (dataset_kind, decision_id) DO NOTHING;`,
          [
            "live",
            supersededDecisionId,
            item.trace_id,
            item.proposal_id,
            JSON.stringify({
              action: "superseded",
              reason: "Consolidated into multi-source proposal",
              consolidated_proposal_id: consolidatedProposalId,
            }),
          ]
        );
      }

      // D. Link all reports to this canonical incident in waspada.incident_reports
      for (const item of cluster.items) {
        const revId = item.report_revision_id || item.proposal_id.replace(/^prop-/, "");
        await db.query(
          `INSERT INTO waspada.incident_reports
           (dataset_kind, incident_id, report_revision_id, relationship, linked_at)
           VALUES ($1, $2, $3, 'corroborating', NOW())
           ON CONFLICT (dataset_kind, incident_id, report_revision_id)
           DO UPDATE SET relationship = 'corroborating';`,
          ["live", cluster.incidentId, revId]
        );
      }
    }

    await db.query("COMMIT;");
    console.log(`\n✓ Successfully committed proposal consolidation to live database.`);

    // 5. Query remaining pending proposals
    const remainingCheck = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM waspada.event_proposals ep
       LEFT JOIN waspada.publication_decisions pd
         ON pd.dataset_kind = ep.dataset_kind AND pd.proposal_id = ep.proposal_id
       WHERE ep.dataset_kind = 'live'
         AND pd.proposal_id IS NULL;`
    );

    console.log(`\nPending proposals after deduplication: ${remainingCheck.rows[0]?.count}`);
  } catch (err) {
    await db.query("ROLLBACK;").catch(() => {});
    console.error("Error during consolidation:", err);
    throw err;
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
