# Waspada Jakarta — source acquisition and verification plan

This expands [the project plan](PROJECT_PLAN.md) within the five-layer design in [ARCHITECTURE.md](ARCHITECTURE.md). Layer 1 acquires and preprocesses evidence, Layer 2 retrieves and assesses it, Layer 3 investigates remaining gaps, Layer 4 decides publication, and Layer 5 evaluates all stages. It preserves broad event coverage and location- and group-based relevance. Initial publication requires moderator review; source-specific automatic publication is enabled only after the acceptance gates in the [Software Development Plan](SOFTWARE_DEVELOPMENT_PLAN.md) pass. The defaults below are proposed prototype settings; they are not provider service guarantees or predictions of ground conditions.

## 1. What verification means

Verification has several separate questions: is the source authentic, is it in a position to know this particular fact, does the material support the proposed claim, does it refer to the correct event and time, and is other evidence genuinely independent?

Assess individual claims. A transport operator can establish a change to its own service without establishing the cause or severity of a nearby security incident. An organiser can establish its announced event schedule; separate evidence is needed to describe attendance or conditions on the ground. Police statements retain attribution, particularly where allegations or disputed accounts are involved.

The public event page should show sources beside the details they support. A source count alone does not establish accuracy. Separate the number of documents from the number of independent evidence origins for each claim. Model agreement and model confidence do not add evidence origins.

Maintain a source registry before enabling automatic publication. For each source, record its owner and publisher group, authentic domain and linked accounts, geographic coverage, subjects it can speak to directly, access method, reuse requirements, refresh interval, identity-check date, connector health, and approval state. Source onboarding is a moderator action; the agent can suggest candidates.

An account is authenticated through links from the institution's own website or another established institutional reference. A display name, badge, screenshot, or search ranking alone is insufficient. Organisers, newsrooms, service operators, and authorities each have useful but different roles; their involvement and possible conflicts remain visible in the evidence record.

## 2. Sources to combine for each event category

The table identifies suitable source combinations. Some provide complementary facts rather than independent confirmation of the same fact. Named pages below establish candidate information channels; only the endpoints in section 3 have been tested as structured feeds in this planning work.

| Category | First sources to obtain | Complementary or independent sources | What to verify separately |
| --- | --- | --- | --- |
| Crime and personal security | Police incident releases through [Tribratanews](https://tribratanews.polri.go.id/); [ANTARA Metro/crime reporting](https://www.antaranews.com/rss?mobile=true) | Separately gathered reporting from a second approved newsroom; public operator or institution statements where relevant; [OJK notices](https://ojk.go.id/id/berita-dan-kegiatan/info-terkini/Pages/Tingkatkan-Pelindungan-Konsumen-Satgas-Pasti-Lakukan-Soft-Launching-IASC.aspx) for scam advisories | Incident date and scene, allegation status, current public consequence, and whether articles all quote one police statement |
| Demonstrations and public gatherings | Organiser's authenticated public announcement; [Dishub notices](https://dishub.jakarta.go.id/) and [Korlantas](https://korlantas.polri.go.id/) | Operator notices through [Transjakarta's official channels](https://www.transjakarta.co.id/); separately gathered field reporting | Planned versus observed gathering; actual versus conditional road restrictions; each service change; separately evidenced violence |
| Crowds and major events | Authenticated organiser and venue announcements | Transport authorities, service operators, and original reporting at the venue | Schedule and access rules versus observed crowd conditions; cancellation; precise venue or entrance affected |
| Violence and immediate threats | Attributed police or emergency-service statement; original reporting | Another independently gathered report; affected facility's own public notice; documented first-hand evidence for moderator review | Specific incident, place and time, ongoing versus historical threat, and conflicting accounts; do not infer violence from gathering size |
| Disasters and weather | [BMKG warnings](https://data.bmkg.go.id/peringatan-dini-cuaca/), [BPBD](https://bpbd.jakarta.go.id/), and [PetaBencana reports](https://docs.petabencana.id/routes/laporan-urun-daya) | Original local reporting and notices from affected transport or facility operators | Forecast versus observation; location and observation time; origin of repeated data; warning validity; service effects |
| Fires and infrastructure hazards | Fire/emergency authority notices where available; [BPBD incident coverage](https://bpbd.jakarta.go.id/tag/8/kebakaran) | Building or utility operator notices; independently gathered reporting; PetaBencana fire reports when available | Active incident versus later recovery coverage; incident location versus aid-distribution site; explicit restrictions and their boundaries |
| Transport and road incidents | Dishub/Korlantas for road measures; the relevant operator for its own services | Another affected operator and original reporting or observations | Route or road segment, direction, timing, announced versus implemented change, and whether the reported cause is independently supported |
| Utilities and essential services | [PAM JAYA disruption notices](https://pelanggan.pamjaya.co.id/gangguan-layanan); public notices from the responsible electricity or communications provider | Affected facility's notice and independent local reporting | Service area, scheduled versus ongoing outage, restoration estimate versus confirmed restoration; no assumed access to private customer systems |
| Health and environmental advisories | [Dinkes Jakarta](https://dinkes.jakarta.go.id/), [Kemenkes notices](https://infeksiemerging.kemkes.go.id/), and [Udara Jakarta](https://udara.jakarta.go.id/parameter-pengukuran) | Original local reporting or another directly relevant measurement or notice with its own provenance | Alert versus confirmed local occurrence; affected population; observation period and station; comparable units and index definitions |
| Group-specific critical notices | Issuing school, campus, employer, or relevant authority; [JakEdu](https://edu.jakarta.go.id/) as an institutional starting point | The affected institution's own publication and original reporting | Exact institution or group, dates, conditions, and whether a repost refers to the same notice; school-closure feed access is not established |

For original journalism, ANTARA is the initial feed provider. Kompas.com and Tempo.co are proposed additional newsroom candidates for permitted original-article retrieval or moderator-submitted URLs. Their feed/API access and reuse arrangements have not been validated here. Evaluate reporting provenance article by article; outlet reputation does not make a copied statement independent.

Public social posts can supply discovery leads. For the prototype, moderators submit original URLs from authenticated institutional accounts or relevant public reporting. Automated social collection requires a supported, authorised access method before activation. Private groups, private reports, and personal tracking are outside this acquisition plan. A screenshot without an accessible original remains an unverified lead.

## 3. Acquisition methods and feasibility findings

The current implementation-facing [source feasibility matrix](docs/SOURCE_FEASIBILITY.md) records the 24 September checks, activation gates and retention baseline. The earlier observations below remain dated evidence, not current source permissions or a guarantee of live coverage.

Prefer documented APIs and RSS. Use permitted public-page retrieval when a feed supplies a link but insufficient content. Where automated access is unavailable, accept an original URL plus a moderator-reviewed excerpt and provenance. Keep this manual path available for all categories.

Read-only endpoint checks on **11 September 2026** produced these results:

| Source | Entry point | Observed result | Prototype use |
| --- | --- | --- | --- |
| BMKG | [RSS/CAP index](https://www.bmkg.go.id/alerts/nowcast/id) followed by each detail link | HTTP 200 and parseable XML; a sampled detail had an expiry before the check date despite the feed's recent build timestamp | Validate individual warning fields; expired entries do not enter the active map |
| PetaBencana | [Jakarta reports as GeoJSON](https://api.petabencana.id/reports?admin=ID-JK&geoformat=geojson) | HTTP 200 and an empty FeatureCollection | Supported report ingestion; empty results do not establish that Jakarta has no incidents |
| ANTARA Metro | [Metro RSS](https://www.antaranews.com/rss/metro.xml) | HTTP 200 and 20 items | Broad discovery; filter unrelated advice and non-Jakarta stories |
| ANTARA crime | [Crime RSS](https://www.antaranews.com/rss/metro-kriminalitas.xml) | HTTP 200 and 20 items | Crime discovery; handle retrospective articles and multi-event roundups |
| Korlantas | [RSS feed](https://korlantas.polri.go.id/feed/) | Feed advertised by its homepage; HTTP 200 and 10 items | Traffic/disruption discovery; filter nationwide coverage to relevant places |
| Other official pages | Dishub, Transjakarta, Dinkes, PAM JAYA, BPBD, and institutional pages | Relevant public pages identified; automated freshness, completeness, and extraction have not been established for every site | Activate individual adapters after access and extraction checks; otherwise use the URL-submission path |
| Optional cross-publisher discovery | [GDELT DOC API documentation](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/) | One article-search probe timed out | Evaluate as an optional discovery connector; it is not a required prototype dependency |

These findings are bounded checks. A successful response does not establish publisher permission for every downstream use, full article accessibility, comprehensive coverage, or future uptime. Documented [ANTARA RSS](https://www.antaranews.com/rss?mobile=true) supplies a clear discovery path. [BMKG](https://data.bmkg.go.id/peringatan-dini-cuaca/) requires attribution and documents an access limit; [PetaBencana](https://docs.petabencana.id/routes/laporan-urun-daya) requests a User-Agent header and documents its report filters.

The ingestion worker should:

- Poll BMKG every 2 minutes, PetaBencana every 5 minutes, and the news/traffic feeds every 10 minutes. Review permitted HTML indexes every 15 minutes; slower institutional or health-advisory indexes every hour. Provider restrictions always override these proposed intervals.
- Store a feed cursor, canonical URL, provider identifier, retrieval time, and content hash. Hash the relevant article or notice content so rotating widgets and feed build timestamps do not trigger new preprocessing jobs. Use conditional requests where supported. Process only new or changed material, and record coverage gaps if a short feed window was missed.
- Fetch the original article or linked official document when needed. Search snippets, headlines, comments, and advertisements are not substitutes for the article's evidence. Split news roundups into separate event candidates before matching.
- Retain source revisions, supporting excerpts, attribution, and hashes. Retain full source material only when its access and reuse terms permit it. Public pages display concise summaries and original links.
- Treat PDFs or images as source formats. OCR can propose text, but dates, boundaries, and instructions extracted only from images require moderator comparison with the original before publication.
- Back off after errors, respect rate-limit responses, and flag failed or changed parsers. Access failures become source-health records, not evidence of incident resolution.

The first release needs no purchased news feed. Cross-publisher search can later use a supported search API or an accepted GDELT integration. Results supply candidate original URLs; they are never a second evidence source in their own right. If discovery is unavailable, use already collected sources and queue any claim that still lacks sufficient evidence.

## 4. Processing, grounding and bounded investigation

### Layer 1 — preprocessing and evidence storage

An incoming report starts a dedicated preprocessing job. Clean and parse it, then extract candidate category, actual event time or time range, location names and their roles, affected services or groups, and unresolved claims. Known formats use deterministic parsers; ambiguous prose uses Layer 2's fixed extraction adapter with no tools. Preserve date precision and relative-time context. The word “Jakarta” in a newsroom dateline or agency address does not establish the incident's location.

Persist source revisions, evidence spans and candidate entities before investigating. Store relational metadata and PostGIS geometry separately from versioned chunk embeddings in pgvector. Embed permitted, privacy-minimized excerpts; retain source revision, offsets, model version and text hash. Corrected/retracted material invalidates derived embeddings and caches, and retrieval rechecks revision status. Similar vectors identify candidates, not independent confirmation.

### Layer 2 — initial retrieval and grounding

Retain an item when its affected geography intersects Jakarta or its explicit national or group-specific applicability includes people in Jakarta. This preserves relevant national advisories while excluding unrelated stories that merely mention the city.

Search the existing event store first. Exact provider alert identifiers and explicit update references identify revisions. For cross-source matching, require a shared event reference or compatible specific location and event time plus distinguishing public event details, such as venue and announced event identity, service number, or incident description. Similar headlines or proximity alone create candidates, not an automatic merge. Ambiguous matches go to review.

Combine exact identifiers and reviewed decisions with spatial/time candidate filtering, lexical terms and semantic retrieval. Explicit service/institution/audience lookup supports notices without geography. Initially retrieve up to 20 candidate chunks and supply at most 8 evidence chunks to synthesis, retaining relevant contrary evidence. Record source state, evidence spans and index version in a GroundingContext. These configurable bounds require recall evaluation; retrieved claims remain revisable evidence, not assumed truth.

Use separate low-latency extraction, embedding and reasoning capability configurations. The reasoning adapter assesses claim support and produces a typed EventProposal when sufficient context exists. Missing or conflicting facts become an InvestigationRequest for Layer 3. Both paths eventually use Layer 4 policy checks. Schema validation cannot by itself prove semantic support.

### Layer 3 — investigation only for remaining gaps

Choose the next source according to the missing claim: a bus operator for service status, an organiser for an announced schedule, emergency services for a cordon, or another newsroom's original reporting for conditions on the ground. Use public event details and Indonesian terms such as “pengalihan”, “penutupan”, “klarifikasi”, “dibuka kembali”, or “dibatalkan” in focused searches. Search for corrections and contrary evidence as well as confirmation.

The shared prototype budget is 5 tool attempts, 4 reasoning turns, 60 seconds of active investigation time and 12,000 total model input/output tokens per event-revision investigation. Stop at the first limit; count failed attempts, retries and model calls caused by the investigation. One fetch attempt covers one original document. Reuse cached material, stop repeated lookups, and escalate after two results add no usable evidence. Persist counters across restarts and moderator pauses. New material goes through Layer 1 processing and Layer 2 grounding before reassessment. Budget exhaustion cannot establish support; forward eligible claims to the publication service and queue unresolved claims with explicit reasons. These are configurable design limits, not measured capacity.

### Layer 1 lineage and Layer 2 claim assessment

Represent each proposed claim with its subject, action or condition, event time, location or affected group, qualifiers, and supporting source excerpts. Connect evidence as supporting, contradicting, updating, or providing context.

Track the underlying origin for each claim: an authority's statement, an operator notice, an organiser announcement, a newsroom's own observation or interview, an original document, or a crowdsourced observation. One article may contain several origins and support several different claims.

To identify copied coverage, inspect explicit credits, linked originals, wire bylines, quoted speakers or statements, repeated text, and reused media. Text similarity is a duplicate-detection signal; it does not by itself prove dependence or independence. When the reporting origin cannot be established, record it as unknown and do not count it as an additional independent origin.

Examples:

- One police release quoted by three publishers is one evidence origin for the police account.
- Two sites displaying the same BMKG warning are one origin for that warning. [BPBD's weather section identifies BMKG as its source](https://bpbd.jakarta.go.id/index.php).
- A reporter's original observation and a separate operator's service notice can support different claims in the same event. They do not automatically corroborate every detail of the event.
- Two independently gathered observations of the same blocked road at compatible times can corroborate that road condition, while its cause remains unresolved.

### Layer 1 geography and Layer 4 map eligibility

Resolve place names against a maintained Jakarta gazetteer containing administrative hierarchy, public landmarks, roads, stations, and aliases. Keep roles such as incident scene, arrest location, interview location, and affected service distinct. A geocoder resolves a place; it does not verify that an incident happened there.

Validate geometry, coordinate conventions, and intersection with the claimed area. Use supplied official boundaries for warnings. Locate a reported incident only to the precision supported by its sources. Apply the same claim checks to affected-group tags: a notice covering specified schools cannot become a citywide school closure.

## 5. Publication rules and worked examples

Layer 4 runs publication checks for each claim and each map feature, regardless of whether Layer 3 was needed. Every public claim needs an approved source, accessible supporting content or a documented moderator evidence review, temporal context, preserved qualifiers, and no unresolved material contradiction. Mapping additionally needs supported geography. An official source has authority over its own notices; its account of disputed conduct remains attributed. Code validates identities, references, timing, geometry and recorded assessment status; uncertain semantic support is reviewed by a person instead of being treated as proven by schema validity.

| Evidence situation | Public treatment | Automatic action |
| --- | --- | --- |
| Authentic notice from its issuing authority or operator, within its remit and validity | “Official notice” with issuer, scope, and dates | Publish the notice and its supplied scope without waiting for a second outlet |
| Eligible original news report or attributable authority account | “Reported by …” / “According to …” | Publish supported, appropriately qualified incident details; preserve allegation status |
| At least two demonstrably independent origins support the same claim at compatible times and locations | “Corroborated by independent reports” for that claim | Add the corroboration label; it does not authorise an inferred danger radius or establish criminal guilt |
| Valid PetaBencana observation with usable time and location | “Crowdsourced report” with provider attribution | Publish as a report in its labelled layer; preserve provider metadata without treating its status as platform-wide verification |
| Anonymous social claim, inaccessible original, uncertain authenticity, or unclear OCR | Internal lead | Investigate or send to review; do not auto-publish an unsupported public allegation |
| Material contradiction or ambiguous event match | Claim under review | Hold the disputed claim; eligible independent details can publish. Reassess any existing map feature or update that depended on it |

Unverified guilt claims, unsupported evacuation instructions, newly inferred exclusion zones, and local outbreak declarations require stronger evidence than repeated news coverage. The prototype relays valid issuer instructions and supplied boundaries; it does not create these decisions itself. Moderators must supply a supported correction or leave the claim unresolved, rather than approving missing evidence away.

**Worked example: demonstration near a public venue — illustrative, not a live alert.**

| Material obtained | Claim it supports | Result |
| --- | --- | --- |
| Authenticated organiser announcement | Gathering scheduled at the venue during a stated period | Publish as planned; attendance is not established |
| Dishub notice saying diversions will apply if required | Conditional traffic arrangements | Preserve the condition; do not mark every road as currently closed |
| Operator update confirming a particular service is diverted | That service's current change and affected stops | Publish the service impact with its own timestamp |
| Original reporter observation of a gathering at the venue | Gathering observed at the reported time | Add an attributed observation |
| Several reposts of an undated confrontation video | No established current incident | Queue the lead; no violence label or warning polygon is generated |

This event can contain several useful sources without every source confirming the same claim. A later operator reopening message updates the service impact, not automatically the gathering's status.

**Worked example: reported robbery.** A crime-feed article quotes a police statement about an incident two days earlier. Two further outlets repeat it. The event has three articles but one origin for the police account. Publish an attributed historical incident with its event date and appropriate public location. If another newsroom has independently gathered material about that incident, assess the particular facts it supports. A later arrest in a different neighbourhood updates the case history without relocating the crime or creating an active warning at the arrest site.

**Worked example: flood and weather.** A BMKG forecast, a PetaBencana observation, and a bus diversion notice answer three different questions. Display the weather warning, the timestamped observation, and the service effect separately. The forecast does not independently confirm the observation's reported water depth.

## 6. Freshness, contradictions, and source failures

Layer 1 maintains separate fields for event time, source publication time, observation time where available, fetch time, and validity. Layer 4 applies expiry and correction rules; Layer 5 monitors propagation and source health. A new fetch, HTTP 304, or feed build timestamp never renews an observation's freshness.

- Respect an issuer's explicit validity window and cancellation/update references. Planned events stay planned until observed or otherwise supported as occurring. An elapsed scheduled end is not evidence that an unbounded incident has resolved.
- For fast-changing observations without an explicit validity window—flood conditions, fires, accidents, crowd conditions, or immediate threats—use a prototype review deadline of 60 minutes after the observation time. After that, label the observation stale and remove implications that it describes current conditions. The historical record remains available.
- A historical crime record remains dated news. It enters an active-threat presentation only when there is separate, fresh evidence of an ongoing threat. Undated material cannot enter a current-condition layer automatically.
- For an advisory lacking a stated end date, display that limitation and require review within 24 hours before continuing to prioritise it as current. Review must find applicable evidence; merely reopening the original page does not reset validity.
- Compare apparent conflicts at the same time, place, and claim scope. A road closed at 10:00 and reopened at 11:00 is a sequence, while opposing descriptions of its state at 10:00 require investigation. Newer publication alone does not make a report more authoritative about an earlier event.
- When a source corrects or retracts evidence, recompute dependent claims, labels, summaries, map features, and in-site updates. Preserve the correction history and issue a material correction to people following an affected event.
- Show connector degradation and last successful retrieval. Three consecutive failed polls flag the connector for attention; backoff continues. Coverage gaps never produce an “all clear”.

For disputed crime or public-order accounts, authority, newsroom, and participant statements retain their attribution. Resolve supported factual differences where possible; avoid majority voting or automatically treating an authority's account as dispositive. During review, keep independently supported operational information available.

## 7. Data interfaces, implementation sequence, and evaluation

Add these concepts to the backend contracts:

| Record | Minimum information |
| --- | --- |
| Source registry | Identity, remit, publisher group, approved URLs/accounts, access method, restrictions, refresh policy, health |
| Report revision | Canonical URL/provider ID, source, published/fetched times, content hash, permitted supporting excerpts, revision relationship |
| Extraction result and evidence chunk | Typed candidates and unknowns; normalized source offsets; embedding model/version, dimension and text hash |
| Grounding context | Retrieved source spans, candidate event versions, source/review states, conflicts, missing facts and retrieval/index version |
| Investigation request and checkpoint | Existing context, specific gaps, case/revision ID, tool/turn/time/token counters, stop reason and trace ID |
| Claim and evidence | Exact proposed fact with time/place/group/qualifiers; supporting or contradicting report spans; origin and dependency relationships; independence status |
| Event and impact | Related claims, event identity, time range, location precision, separately timed effects, supported audience tags |
| Publication decision | Rule applied, eligible claims, exclusions/review reasons, geometry provenance, freshness, version, moderator changes |

Layers 2 and 3 return EventProposal records under the same strict schema; Layer 4 applies the final decision and stores its evidence references. The contract definitions are in [docs/contracts.schema.json](docs/contracts.schema.json), with cross-record validation rules in the architecture specification. The public API returns eligible claims and their evidence labels, citations, status, and freshness. The moderator API exposes unresolved claims, source lineage, candidate matches, and the audit trail. Agent tools have bounded read access to approved public sources; retrieved content cannot grant tools or change publication policy. Restrict fetching to approved public hosts and recheck redirects to prevent source URLs reaching private services. Restrict worker database roles so model proposals cannot write published event versions.

Implementation sequence:

1. Deliver Layer 1 source registry, revision storage, connectors, preprocessing, spatial data and versioned evidence chunks. Verify permitted use, filtering, attribution and failures. Start Layer 5 traces and labelled fixtures here.
2. Add complementary newsroom/operator/institution examples and Layer 2 typed model adapters plus spatial/semantic retrieval. Benchmark support and contradiction recall, event matching and the direct grounded proposal path.
3. Add Layer 3 only to cases with remaining gaps. Test finite budgets, no-progress stopping, resume counters and hostile source content with automatic publication disabled.
4. Integrate both proposal paths with Layer 4 policy, moderator review, idempotent event updates and frontend. Enable sources/rules only after held-out cases pass. Layer 5 tracks quality, health, cost and corrections; model/index/policy changes require review and reevaluation.

Extend the existing evaluation to **at least 40 reports across at least 12 event cases**, with at least three documents in each case and extra revisions where needed. Include all ten categories, with deeper scenarios for crime, demonstrations, and flooding. Two team members should label evidence origins, event identity, claim support, timing, location, and expected publication decisions, then reconcile differences before scoring.

Required cases include one release repeated by many outlets; independent reporting; one article containing several events or origins; a conditional diversion; a scheduled event cancelled before it starts; the wrong arrest location; an old image; a fresh feed carrying an expired alert; an empty feed; missing or inaccessible originals; contradictory accounts; an out-of-area report with a Jakarta dateline; non-geographic audience notices; source outages; and retraction of previously published evidence.

Layer 5 reports claim-support precision, extraction accuracy, retrieval recall@k (including contrary evidence), evidence-origin errors, event merge/split errors, timestamp/location accuracy, review rate, publication latency and cost by model role. Keep all revisions and copied sources from one incident in the same evaluation split. Additional checks cover sufficient-context bypass of Layer 3, budget preservation after restart, non-geographic retrieval, and retracted evidence still present in a stale vector index. The demonstration gates are: every published claim has traceable support, no known copied origin counts as independent, no expired warning remains active, no unsupported geography/current-danger implication appears, and corrections reach all dependent displays. Passing this dataset establishes prototype behaviour, not production accuracy.
