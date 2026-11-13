# Master test plan

Project: Waspada Jakarta (Team 12, RPL course).
Document: TEST-PLAN. Status: draft for review, 13 November 2026.
Basis: Braude and Bernstein, *Software Engineering: Modern Approaches*, Part VII (Chapters 25–28); Software Development Plan (SDP) section 10 and requirement tables; `.github/workflows/ci.yml`.

## 1. Purpose and scope

This plan sets out how the local live mode and the synthetic demo of Waspada Jakarta are tested against the functional requirements FR-01 to FR-15 and the quality requirements NFR-01 to NFR-08 in the SDP.

Out of scope for this plan:

- Hosted deployment on Cloudflare Workers and Neon. The target is designed, not deployed, and hosted behaviour is not tested.
- Android device testing and release validation. The Flutter analysis and unit tests are local evidence only.
- The held-out evaluation with labelled cases (SDP section 10). It depends on source rights and human labels, which are not yet available.

## 2. Test items

| Item | Role | Test runner |
| --- | --- | --- |
| `apps/worker` | Cloudflare Worker API, L4 publication gate, public routes | Node test runner |
| `apps/db` | PostgreSQL and PostGIS schema, 47 migrations, repositories | Node test runner on PGlite, one process per file |
| `apps/intelligence` | Mastra job runner and model workflow | Node test runner |
| `apps/web` | React client (map, incident detail, administrator workspace) | Node test runner |
| `apps/mobile` | Flutter public reader (local only) | `flutter test` |
| `tools/*` | Local pipeline, evaluation, account demo | `tsx --test` |

## 3. Levels and box types

Braude Chapters 25–28 set the levels. The table shows who runs each one and which box type it uses.

| Level | Who runs it | Box type | Main evidence | Document |
| --- | --- | --- | --- | --- |
| Unit | The author of the component | White box, with black box cases from requirements and design | Unit test files, CI log | `DOKUMENTASI_UNIT_TESTING.md` |
| Integration | The team; the reviewer is not the author | Gray box: interfaces and state | PGlite composition tests, TEST-INT-01 | `INTEGRATION-TEST.md` |
| System | The reviewer (a different team member from the implementer) | Black box: use cases and NFRs | System test cases, browser checks | `SYSTEM-TEST.md` |
| Acceptance (UAT) | The team, through browser walkthroughs; human sessions are not yet planned | Black box: user tasks | Walkthrough logs and screenshots | `UAT.md` |

Mutation testing (Braude Chapter 25) is not used. The project does not measure coverage, and no mutation tool is set up. Chapter 5 states this rather than reporting a coverage figure.

## 4. Extent and prioritisation

Braude advises against testing "until time expires", so the extent is set by priority:

1. Must requirements first: FR-01 to FR-15, each with at least one test case in `test-cases.csv`.
2. Within the Must set, the quality requirements that protect safety and data come first: NFR-01 (evidence integrity), NFR-02 (resource bounds), NFR-05 (reliability), and NFR-07 (privacy and security).
3. The remaining quality requirements (NFR-03, NFR-04, NFR-06, NFR-08) follow.

Tests that cover behaviour the requirements do not name are not added to the plan.

## 5. Test inputs

- **Synthetic fixtures** committed to the repository and labelled as synthetic. These are the main inputs for unit and integration tests.
- **The demo dataset** (`DATASET_MODE=demo`) for system and UAT runs. Its accounts are `demo.warga`, `demo.moderator` and `demo.admin`, defined in `tools/accounts/demo-accounts.ts`. Passwords come from that file and are never printed in reports.
- **Live feeds** (PetaBencana, BMKG and 14 RSS feeds) are used only in the local live run (`npm run serve:live`). They are never used as inputs to automated tests, and CI does not poll them.
- **Model responses** in automated tests come from authored doubles and simulated providers. Real model calls use quota and are not part of routine testing.

## 6. Test environment

- WSL Ubuntu 26.04, with Node 24 (CI uses Node 24 on ubuntu-24.04). Lockfiles are authoritative.
- PGlite for database tests. The production target, Neon PostgreSQL, is not used in tests.
- Playwright (Chromium) for browser checks and UAT walkthroughs.
- GitHub Actions runs the full suites on every push and pull request to `main`.

Local test policy (owner decision, 12 November 2026): locally, run only `npm run typecheck` and the new or changed test files, one at a time. The full worker suite, `db:test`, `test:intelligence`, `pipeline:test`, `npm test` and `npm run build` run in CI, because the 7 GB WSL host has crashed under them.

## 7. Roles and responsibilities

- **Author:** writes and runs the tests for the component they built.
- **Reviewer:** checks the behaviour, the evidence and the interfaces before a task is accepted. The reviewer is not the author of the component under review.
- **Orchestrator:** owns the test plan, the test case register, the defect log and the final summary.
- **Limitation:** the team has three members, so independence is partial. Chapter 5 says so.

## 8. Metrics

Braude (Chapter 25, step 8) asks for metrics to be defined before testing starts. The following are collected:

- Tests run, passed and failed for each CI step (from the CI log).
- Defects found, grouped by level and by requirement, each with its cause and the commit that fixed it (`DEFECTS.md`).
- Browser walkthrough results: pass or fail per step, and seconds per task (`UAT.md`).
- Non-functional measurements exactly as defined in `SYSTEM-TEST.md`. Latency (NFR-04) has no measured value yet.

## 9. Schedule and dependencies

- Integration gate M5: Weeks 9–10 (SDP section 8).
- Final evaluation, usability, quota and latency report, and restore rehearsal: M6, Weeks 11–12.
- Usability: the decision on 13 November 2026 is browser walkthrough only. No human sessions are planned, so NFR-03 is not evidenced. Table 2.3 in the report lists usability sessions in Week 10; this must be aligned with M6 or marked as not held.

## 10. Stopping criteria

Braude (Figure 25.9) lists the criteria. This plan uses:

- The planned test cases for the level all pass, and their results are recorded.
- A full run of the level's tests finds no new defect.
- Every release-blocking defect in SDP section 10 is closed before release. These are: unsupported publication, exposed personal data, wrong active warning geometry, budget bypass, and unauthorised moderation.
- A coverage goal is not used, because the project does not measure coverage.

## 11. Regression rule

Braude's rule (Figure 25.3): if a test target C depends on changed code N, C is retested. If C is known to be independent of N, it need not be retested. Otherwise retest C.

In practice, every change triggers the full CI suite on push to `main`. For a change to one component, the dependency tables in `INTEGRATION-TEST.md` name the components that must also be retested. Where independence is not clear, the dependent component is retested.

## 12. Risks to testing

| Risk | Effect | Mitigation |
| --- | --- | --- |
| No human usability sessions | NFR-03 and user acceptance are not evidenced | Stated in Chapter 5; the UAT protocol is ready if sessions are run later |
| Local memory limit | Full suites cannot run on the 7 GB host | CI runs them; local runs are limited by policy |
| PGlite is not Neon | Hosted behaviour is not tested | Stated as a limitation; hosted tests are planned work |
| Intermittent failures | Flaky tests were recorded in the unit report | Each recurrence is logged in `DEFECTS.md` and fixed at the root |
| Partial independence (three-person team) | Authors review work close to their own | Reviewer sign-off is recorded per task |

## 13. Documents

| Document | Purpose |
| --- | --- |
| `TEST-PLAN.md` | This plan |
| `DOKUMENTASI_UNIT_TESTING.md` | Unit test report |
| `docs/testing/INTEGRATION-TEST.md` | Integration test plan and report |
| `docs/testing/SYSTEM-TEST.md` | System test specification |
| `docs/testing/UAT.md` | User acceptance test plan and walkthrough scripts |
| `docs/testing/test-cases.csv` | Test case register |
| `docs/testing/DEFECTS.md` | Defect and incident log |
| `docs/testing/TEST-SUMMARY.md` | Summary and limitations |

## 14. Approval

No approval is recorded yet. This plan is a draft for review.
