# Waspada Jakarta — revised project concept and proposal

For the current engineering delivery baseline, requirements and implementation/review workflow, start with [SOFTWARE_DEVELOPMENT_PLAN.md](SOFTWARE_DEVELOPMENT_PLAN.md). This document retains the product concept and taxonomy.

**Working title:** Waspada Jakarta

**Deliverable:** A software engineering concept and proposal for an interactive Jakarta safety and disruption website.

**Scope decision:** Crime, demonstrations, public gatherings, and other consequential disruptions are core categories. Source integrations and demonstration scenarios will be introduced incrementally.

## 1. Purpose and audience

Create a website that connects recent incidents and critical advisories to affected places and groups. A five-layer AI system processes and retrieves evidence before deciding whether further investigation is needed. Bounded orchestration is Layer 3; backend policy publishes eligible claims and sends uncertain cases to moderators. The detailed boundaries and contracts are specified in [ARCHITECTURE.md](ARCHITECTURE.md).

The problem hypothesis is that people struggle to determine which reports affect them, whether an event is still relevant, and what practical guidance is available. Validate this through interviews before presenting it as an established finding.

The primary audience changes with the event: residents, travellers, commuters, students, parents, outdoor workers, businesses, and participants in public events. Relevance can depend on geography, a named service or institution, an explicitly affected group, or a combination of these.

Each event should answer:

- What happened or is scheduled to happen?
- Where and when does it apply?
- Which people, services, or activities are affected?
- What effects and guidance are supported by the sources?
- How current is the information, and what remains uncertain?

Jakarta already provides services such as [Pantau Banjir](https://www.jakarta.go.id/pantau-banjir) and [JAKI emergency information](https://smartcity.jakarta.go.id/en/blog/kontak-darurat-jaki-akses-pertolongan-genting-di-jakarta). The proposed value is connecting sources, explaining relevance, and tracking changes across event categories. Test this proposed advantage with users.

## 2. Event coverage and demonstration scope

An item belongs in the platform when it has a concrete safety or disruption consequence for an identifiable place or group. General-interest news needs such a consequence to qualify.

| Event category | Examples | Information to present |
| --- | --- | --- |
| Crime and personal security | Reported robbery, theft, assault, harassment, and scam advisories | Event time, appropriately precise location, source attribution, report status, and any current advisory |
| Demonstrations and public gatherings | Protests, marches, rallies, and strikes | Announced or observed location and schedule, access restrictions, and documented service effects |
| Crowds and major events | Concerts, sporting events, festivals, and overcrowding | Venue area, event period, documented crowd conditions, and access or transport changes |
| Violence and immediate threats | Reported street fights, violent clashes, and official security alerts | Specific reported incident, supported affected area, timing, and official instructions where available |
| Disasters and weather | Flooding, severe weather, earthquakes, and fallen trees | Observations, official warning areas, warning validity, and affected facilities or roads |
| Fires and infrastructure hazards | Building fires, gas leaks, collapses, and damaged infrastructure | Reported location, documented restrictions, and response updates |
| Transport and road incidents | Accidents, road closures, diversions, and public transport interruptions | Affected road segments, services, stops, and operating periods |
| Utilities and essential services | Water, electricity, and major communications outages | Affected service areas or customer groups, schedules, and provider updates |
| Health and environmental advisories | Official outbreak notices, pollution alerts, and contamination warnings | Source-defined affected locations or groups, validity, and official guidance |
| Group-specific critical notices | School closures, evacuation notices, and notices affecting occupations or communities | Named institutions or groups, effective dates, eligibility or applicability, and source instructions |

Assign an event a primary category and additional tags as needed. Store its effects separately: a demonstration can cause a road closure; a flood can interrupt a bus service. Link these developments to the originating event while preserving their distinct locations and validity periods. Avoid counting the same event as multiple independent incidents because it has several effects or articles.

The first integrated demonstration covers:

1. **A crime report:** Extract the event date and public location, attribute the report, and distinguish the original incident from later investigation coverage.
2. **A demonstration with transport impacts:** Connect a gathering announcement, traffic notice, and service update; identify relevant information for participants, nearby residents, and passengers.
3. **A flood and weather situation:** Display reported flood locations alongside an official weather warning, preserving their different meanings and validity periods.
4. **A group-specific advisory:** Demonstrate that a school notice or scam advisory can reach its relevant audience without requiring a warning polygon.

Use clearly labelled historical or synthetic demonstration records where suitable live data is unavailable. Keep demonstration records separate from live information. Additional categories use the same workflow and can receive integrations as suitable sources are established.

## 3. Website experience and geospatial behaviour

- **Map and linked feed:** Search places and filter by category, event time, status, and source type. Selecting a mapped story highlights its supported location. Relevant notices without map geometry remain accessible in the feed.
- **Event detail:** Present a concise summary, affected places and groups, documented effects, event time, latest source update, citations, source-provided guidance, and a development timeline.
- **Places and interests:** Allow people to follow neighbourhoods, campuses, destinations, services, and optional roles such as student, parent, or public transport user. Explain why each personalised item appears.
- **Personal briefing and update centre:** Summarise relevant events and highlight material changes, including revised effects, cancellations, and corrections. Deduplicate repeated coverage.
- **Moderator dashboard:** Inspect evidence and exceptions; correct records, merge duplicates, approve publications, and retract errors. Retain an audit history.

Choose map representations according to the evidence:

| Evidence or information | Representation |
| --- | --- |
| Official warning boundary | Source-supplied polygon with its stated validity and meaning |
| Reported incident location | Point with location precision and source attribution |
| Documented road or service restriction | Supported line segment, stop, or service information |
| Approximate named area | Clearly labelled location context; an administrative boundary alone does not establish a hazard extent |
| Group-specific notice without useful geography | Audience-targeted feed entry and briefing item |

Keep event type, documented impact, current status, and evidence status distinct. A demonstration entry describes the gathering and documented effects. Any reported violence receives a separately evidenced incident record linked to the gathering only when that relationship is supported.

Crime records use public incident information at the minimum useful location precision, omitting identifying victim or suspect details and private addresses. A historical crime report does not establish a current danger zone. The initial system does not derive neighbourhood crime-risk scores or predictive hazard boundaries from news volume.

Show event time separately from article publication time and ingestion time. When coverage is empty, use wording such as “No recent reports found” alongside source availability. Expired warnings leave the active-warning layer; unresolved incidents with missing updates become stale rather than automatically resolved.

## 4. Five-layer AI architecture and publishing

The detailed [source acquisition and verification plan](SOURCE_VERIFICATION_PLAN.md) specifies source combinations for every event category, tested ingestion endpoints, claim-level evidence rules, publication decisions, update handling, and acceptance scenarios.

The logical layers are:

1. **Data & Knowledge:** Scheduled connectors, cleaning, parsing, entity extraction and persistence operate as dedicated pipelines. Store immutable reports and evidence spans in PostgreSQL, source-supported geography in PostGIS, and versioned semantic embeddings in pgvector. Extraction may call a predefined model adapter without invoking an agent.
2. **Model & Grounding:** Separate low-latency classification/extraction, embedding generation and complex reasoning/synthesis. Retrieve exact event references, spatial/time-compatible records and semantic evidence before autonomous actions. Preserve contrary evidence and source review states; retrieval is not proof of truth. Produce typed, evidence-linked proposals or explicit missing facts.
3. **Inference & Orchestration:** Create an investigation only when initial grounding is insufficient. A persisted coordinator selects approved tools to address the gap. Initial limits are 5 tool attempts, 4 reasoning turns, 60 seconds of active time and 12,000 total model tokens per event-revision investigation, stopping at the first limit. Failed attempts count, and resumes preserve counters. New material returns through Layers 1 and 2. Stop or escalate on conflict, no progress, tool failure or budget exhaustion.
4. **Application Integration:** Both direct and investigated proposals pass the same deterministic backend policy. Validate evidence references, source approval, timing, geometry, current event version and unresolved conflicts. Commit eligible claims and public updates atomically; moderators supply supported corrections through the same gate. Map, feed and briefing read published versions only.
5. **Evaluation & Monitoring:** Measure ingestion health, retrieval recall, claim support, tool budgets, publication quality, cost/latency and correction propagation. Human feedback supplies reviewed evaluation cases. Changes to models, indexes or policies require regression evaluation rather than automatic deployment.

Responsible AI crosses all layers: source provenance, privacy minimization before embeddings, prompt-injection isolation, restricted tools, audit traces and human review of disputed claims. Logical separation does not require five deployed microservices; a modular backend with separate ingestion and investigation jobs is sufficient for the prototype.

Automatic publishing requires an approved source, clear temporal context, an identifiable affected place or group, and evidence for every published factual claim. An issuer's authentic notice can publish as an official notice without waiting for a second outlet. A supported news report can publish with attribution; a corroborated claim additionally requires independently gathered evidence about that same claim. A mapped feature requires traceable geography. Preserve allegations as attributed reports and route material conflicts to review. Do not use an event-wide confidence score to imply that every detail is verified.

Repeated articles based on one original report count as one evidence origin. Preserve crowdsourced labels. Weather forecasts and observed flooding remain distinct. Relevance tags follow explicit source applicability or supported geographic overlap; users choose their own interests and roles. Treat retrieved content as untrusted evidence, never as instructions controlling the agent.

The proposed implementation uses React/TypeScript and Leaflet assets with a modular TypeScript API on Cloudflare Workers, Neon Free PostgreSQL with PostGIS/pgvector, and bounded Cloudflare Workflows for Layer 3 jobs. Logical boundaries remain: independent L1 pipelines; task-specific L2 extraction, embedding and reasoning adapters; L3 only for unresolved investigations; and an L4 deterministic publication gate. Layer 5 evaluates and monitors every stage. Workers AI is an optional no-paid model candidate within the Free neuron allowance; no provider/model is selected until Indonesian-language evidence quality and quota behavior are measured. The shared contracts distinguish ReportRevision, ExtractionResult, GroundingContext, InvestigationRequest, EventProposal and PublicationDecision. A model never supplies an authoritative publish flag. Schema validation checks structure; evidence assessments and moderator review address semantic support. See [ADR-010](docs/decisions/ADR-010-cloudflare-neon-free.md) for hard limits and degraded behavior.

The free-tier deployment target is suitable for a low-volume class demonstration only. It does not establish always-on service, citywide coverage, permission to reuse source material, or an unbudgeted path beyond quotas. Local development and verification use WSL Ubuntu-26.04. No cloud project, live source or paid model has been configured.

Initial source strategy:

- **Weather:** [BMKG warning documentation](https://data.bmkg.go.id/peringatan-dini-cuaca/) provides a structured starting point for warning geometry and expiration; retain required attribution.
- **Disaster reports:** [PetaBencana report documentation](https://docs.petabencana.id/routes/laporan-urun-daya) describes Jakarta-filtered geospatial reports; retain source labels and applicable attribution.
- **Crime and public disruptions:** Use approved police releases and traffic notices as initial candidates. Examples include [Polda Metro advisories](https://tribratanews.polri.go.id/blog/hukum-4/polda-metro-jaya-minta-warga-tak-main-hakim-sendiri-saat-bekuk-pencuri-73642) and [Korlantas demonstration-related traffic information](https://korlantas.polri.go.id/2026-06-12-aksi-unjuk-rasa-hari-ini-polda-metro-jaya-siapkan-rekayasa-lalu-lintas/).
- **Other notices and news:** Add relevant authorities, service operators, institutions, and selected news publishers to a reviewed source registry. Record access method, update frequency, geographic coverage, and reuse conditions for each connector. Display concise summaries and links to original publications.

Initial read-only checks found working BMKG, PetaBencana, ANTARA Metro/crime, and Korlantas feed endpoints. These checks establish a starting point for acquisition, not comprehensive or continuously current coverage. Add permitted article retrieval and moderator-submitted original URLs for complementary reporting, operator announcements, and institution-specific notices. The detailed source plan records availability limitations and how copied coverage, stale items, and missing evidence affect publication.

## 5. Validation, deliverables, and defaults

Validate the problem through six to eight interviews across several affected groups. Investigate how participants currently find relevant information, recognise outdated coverage, and decide whether an event affects them.

Evaluate the concept and prototype with:

- **Usability:** Target at least 80% of participants identifying an applicable event, its freshness, and its source within one minute.
- **AI interpretation:** Build a manually labelled set of at least 40 reports across at least 12 event cases, covering all ten categories with deeper examples for the four demonstration scenarios. Measure claim support, evidence independence, event-time extraction, place resolution, audience relevance, and duplicate grouping separately.
- **Publication quality:** Require evidence references for published factual claims and traceable provenance for mapped geometry. Measure incorrect automatic publications and the share of cases requiring review; AI confidence alone is not a publication criterion.
- **Evidence independence:** Test multiple outlets quoting one release, several claims with different origins in one article, genuinely independent reporting, and uncertain source lineage. Count independent origins per claim and withhold a corroboration label when independence is unclear.
- **Temporal and source failures:** Test old incidents in new articles, planned events that are cancelled, missing resolution statements, expired warnings, outages, and conflicting reports.
- **Geospatial and relevance failures:** Test ambiguous place names, article locations that differ from incident locations, notices without geography, and users outside an advisory's affected group.
- **Crime and gathering scenarios:** Test later arrest coverage, duplicated allegations, peaceful gatherings with traffic effects, and separately reported violence. Confirm that category labels alone do not generate danger zones.
- **Agent and moderation behaviour:** Test misleading source instructions, unsupported summaries, exhausted research budgets, moderator correction, retraction, and suppression of duplicate update alerts.
- **Layer boundaries:** Confirm ingestion/extraction run without the coordinator and sufficiently grounded cases bypass Layer 3. Measure hybrid retrieval recall on supporting and contradicting evidence, and test a non-geographic audience notice. Compare extraction and reasoning models separately. Verify an outdated embedding cannot reinstate a retracted claim and resumes cannot reset investigation budgets.

The proposal should contain the problem hypothesis and interview findings, stakeholders and use cases, the event taxonomy, prioritised requirements, map/feed/detail/moderator wireframes, architecture and agent workflow diagrams, a source feasibility register, and an evaluation plan.

Defaults: Jakarta coverage; Bahasa Indonesia interface; mobile-first layout; optional location access; locally stored preferences for the prototype; public browsing without an account; and visible source timestamps using “latest available” language. Use in-site updates initially. Browser push notifications, route analysis, citizen submissions, and a conversational assistant are later feature extensions.

## 6. Delivery and ownership

Jesaya owns Layer 1 storage/spatial contracts and Layer 4 publication/API services. Perry owns Layer 1 connectors/preprocessing, Layer 2 model/grounding adapters and Layer 3 investigations. Rasya owns the Layer 4 frontend/moderation experience and Layer 5 evaluation/monitoring integration. Each member tests their boundary and reviews another member's work; provenance, privacy and evaluation are shared responsibilities.

The proposed 12-week sequence is needs/sources/contracts (weeks 1–2), Layer 1 and a basic API (3–4), Layer 2 and the direct grounded path (5–6), Layer 3 investigations (7–8), Layer 4 integration and Layer 5 monitoring (9–10), then held-out evaluation/usability/reporting (11–12). Instrumentation and evaluation cases begin in week 1. Model, retrieval or policy changes must pass the same held-out incident cases before release. The schedule remains relative to the course calendar.
