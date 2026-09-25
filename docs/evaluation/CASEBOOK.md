# Evaluation casebook format 1.0

The casebook is a metadata-only format for future rights-cleared historical evaluation. `docs/evaluation/casebook.schema.json` defines its closed Draft 2020-12 shape; `tools/evaluation/casebook.ts` adds semantic checks the JSON Schema cannot express, including identity leakage and release-readiness reasons.

The checked-in [`synthetic-casebook.json`](fixtures/synthetic-casebook.json) is an authored validator fixture. It contains invented identifiers, taxonomy values, and hashes only. It is not a report, human judgment, label set, or ground truth. The validator and fixture do not acquire source material or establish evaluation quality.

## Metadata and rights

Set `dataset_kind` to `historical` or `synthetic`; `live` data is always rejected. Synthetic casebooks always fail release readiness. For each report, store stable report and revision IDs, the source ID, lowercase SHA-256 content hash, known origin-group ID (or explicit `null` when unknown), and an opaque `content_ref`. `content_ref` is only a handle to a separately permission-controlled content store; it is never a URL, credential, body, excerpt, or access token. `synthetic-ref:` handles are for authored synthetic fixtures. `permission-ref:` handles point to an external permission record or content vault and do not themselves assert that rights are approved.

Record each source's `evaluation_use_rights` as `approved`, `pending`, or `not_applicable`. An approved source must have a `permission-ref:` reference. The checker only reads this declaration; it does not verify the permission record or grant permission. Rights approval, source attribution, retention limits, deletion terms, and a lawful basis for retaining source-derived material remain external review gates. No checked-in fixture or test value represents actual rights approval.

Unknown fields are rejected. This deliberately excludes source bodies, excerpts, titles, personal information, geometry payloads, credentials, and model output from the casebook. Scope labels contain only existing domain IDs, not geometry. Keep source content in an access-controlled store governed by the source's actual terms.

## Labels and review records

Each case is one incident grouping and is assigned exactly one split: `development`, `validation`, or `held_out`. Its required `scenario_tags` array records explicit curator coverage for any of `historical_crime`, `gathering_transport_impact`, `weather_warning_flood_observation`, and `non_geographic_group_notice`; it is coverage metadata, not model output. Reviews are separate records with unique reviewer IDs within that case; each is typed as human. Adjudication is a separate reconciled or pending human record. The validator rejects model/machine output fields and non-human reviewer/adjudicator kinds. It does not authenticate a reviewer or prove that a review occurred.

Every label dimension uses a tagged assessment: `{"status":"labeled","value":...}` or exactly one of `unknown`, `disputed`, and `not_applicable`. Case-level labels cover incident identity, category, event time, scope, and expected publication disposition. Each review and adjudication also has exactly one `report_assessments` entry for every report in its case; those entries label report-specific observation time, evidence relation, and source-origin dependence. Missing, duplicate, or out-of-case report assessments are rejected, even when the assessment is explicitly unknown or not applicable. Categories and evidence relations match the existing L2 contracts. Publication dispositions match the existing L4 decision enum. Time values use the schema 2.0 time shape, with strict real calendar/time validation and matching endpoint formats for ranges; scope uses the schema 2.0 ID-only scope shape. These values are expected human assessments in future case curation, not model predictions.

One split is set per case rather than per report. The validator rejects duplicated report IDs, duplicated revision IDs, and report/revision/origin-group/content-hash reuse across cases. A cross-split collision also yields `SPLIT_LEAKAGE`. `null` origin-group values are explicit unknowns and cannot be used to claim independence. This does not prove that distinct IDs or hashes describe independent source material; the curator must establish and review lineage.

For held-out cases, `held_out_freeze` records `state` and `frozen_at` explicitly. A frozen state requires a timestamp; an unfrozen state requires `null`. The validator can check this declaration but cannot enforce a freeze process or prevent later edits. Any change to held-out labels, content membership, rights, or split assignment needs an external review and a new recorded freeze decision.

## Release-readiness check

The deterministic checker reports stable reason codes. A casebook can be structurally valid but not release-ready. Readiness requires all of the following: historical data; approved evaluation-use rights for every source; at least 40 reports across 12 cases; at least three reports, two distinct human reviewers, and a reconciled adjudication in every case; all ten L2 categories represented by `labels.category` on reconciled adjudications; all four scenario tags represented by case metadata; at least one held-out case; and a frozen held-out state with timestamp. Unknown, disputed, or not-applicable category assessments do not count toward category coverage. Minimum checks are independent, so a draft can report multiple blockers at once.

Reason codes are `CASEBOOK_INVALID`, `DATASET_NOT_HISTORICAL`, `SOURCE_RIGHTS_NOT_APPROVED`, `REPORT_COUNT_BELOW_MINIMUM`, `CASE_COUNT_BELOW_MINIMUM`, `REPORTS_PER_CASE_BELOW_MINIMUM`, `HUMAN_REVIEWERS_BELOW_MINIMUM`, `ADJUDICATION_MISSING`, `CATEGORY_COVERAGE_INCOMPLETE`, `SCENARIO_COVERAGE_INCOMPLETE`, `HELD_OUT_SPLIT_MISSING`, and `HELD_OUT_NOT_FROZEN`. A `ready` result only describes the supplied metadata structure. It does not certify rights, reviewer identity, label accuracy, representativeness, model performance, or safety. Root review and actual human adjudication remain required before any release claim.

## Local use

Run `npm test` for the workspace suites and validator tests, and `npm run typecheck` to typecheck workspaces plus the standalone validator. The validator has no runtime dependency and is not imported by the Worker or web bundle. The current tests use invented, in-memory structures only. No real evaluation labels, source rights, or reports are available or asserted.
