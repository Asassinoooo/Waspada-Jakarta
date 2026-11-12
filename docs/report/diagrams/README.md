# Report diagrams (DOC-REPORT-01)

PlantUML sources for the university report figures, drawn for the system as built on 12 Nov 2026.
The report itself is a Google Doc (link in the README), so the old images are not in this repo. Each
line below states what the figure now shows and what it changes. For Figure 1.1 the closest earlier
source in this repo is `docs/diagrams/five-layer-architecture.svg`, whose L3 label is "Inference &
Orchestration".

## Figures

- `fig-1-1-five-layer-architecture.puml`: replaces the old Figure 1.1. L3 uses the CLAUDE.md name "Investigation" (the repo SVG says "Inference & Orchestration"), is marked as implemented but not connected, and the live path that bypasses L2 and L3 is shown.
- `fig-3-1-helicopter-view.puml`: replaces the old Figure 3.1. Adds the 14 RSS feeds, webhook senders, NineRouter, the intelligence job runner and the local PGlite storage; the Android client is public read only with no sign-in.
- `fig-3-2-use-case.puml`: replaces the old Figure 3.2. Google sign-in is removed (ADR-060); adds username and password registration, the admin-only source tab, the moderator tabs, and the system agents with the 48 h expiry.
- `fig-3-3-activity.puml`: replaces the old Figure 3.3. Swimlanes for the live pipeline: the L1 triage gate, the Mastra steps in apps/intelligence, the L4 auto-publish gate (ADR-061), moderator review, and expiry (ADR-062).
- `fig-3-4-sequence.puml`: replaces the old Figure 3.4. Adds the job runner's POST to the Worker's internal proposals route, the alt branch between auto-publish and the moderator queue, and the public read of published versions only.
- `fig-3-5-class.puml`: replaces the old Figure 3.5. Uses real table and column names (migrations 001-047), real enum values, and the claim-label rule that only a moderator may choose independent_corroboration.
- `fig-3-6-freshness-state-machine.puml`: replaces the old Figure 3.6, which is still right. Adds the source-report withdrawn, retracted or superseded transition (migration 034) and the rule that expired means only the issuer's validity window ended.
- `fig-3-7-component.puml`: replaces the old Figure 3.7. Components are grouped by workspace package with real file names; the L3 module is dashed and marked not wired; adds the Flutter client and the local composition root.
- `fig-3-8-deployment.puml`: replaces the old Figure 3.8. Splits the view into local live mode (implemented) and the hosted Cloudflare Workers, Neon and separate intelligence service target (planned, gated: hosting, Neon, source rights).

## Render

Each file sets `skinparam dpi 150` for PNG output. Each file also sets `!pragma layout smetana`, so
Graphviz is not needed. Needs Java plus the `plantuml` command, or `plantuml.jar` run with `java -jar`:

```sh
plantuml -tpng docs/report/diagrams/*.puml
# or: java -jar plantuml.jar -tpng docs/report/diagrams/*.puml
```

Or paste one file's content into https://www.plantuml.com/plantuml and export PNG. The diagram text
holds architecture labels only: no endpoints, keys or personal data.

## Status

Not syntax-checked in this worktree: `plantuml` and a `plantuml.jar` are not installed, and nothing was
installed for the check. Run the render command above before using the PNGs in the report.
