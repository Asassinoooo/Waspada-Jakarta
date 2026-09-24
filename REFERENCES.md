# Waspada Jakarta Reference Register

This working file keeps the sources for the Waspada Jakarta report while the final reference section is being prepared. The chapter currently has no reference list or numbered in-text citations. Keep this register local and prepare the bibliography at the end of the complete report, following the user's later instructions.

## Public and Jakarta context sources

- **BPBD Provinsi DKI Jakarta.** [Rencana Penanggulangan Bencana Daerah Tahun 2023–2027](https://bpbd.jakarta.go.id/perpustakaan/MXNBT0pHUk1YZStsaysxeGREMXlTZz09/rencana-penanggulangan-bencana-daerah-tahun-2023-2027). Report date recorded in the draft: 2 January 2024. Access recorded: 17 September 2026. Use for the Jakarta disaster and resilience context.
- **Pemerintah Provinsi DKI Jakarta.** [Pantau Banjir](https://www.jakarta.go.id/pantau-banjir). Access recorded: 17 September 2026. Use as a reference for Jakarta flood monitoring.
- **Yayasan Peta Bencana.** [About PetaBencana.id](https://info.petabencana.id/about-petabencana-id). Access recorded: 17 September 2026. Use for the community disaster reporting comparison.
- **Jakarta Smart City.** [Intip Isi Update Aplikasi JAKI!](https://smartcity.jakarta.go.id/blog/intip-isi-update-aplikasi-jaki/). Access recorded: 17 September 2026. Use for the related-product comparison.
- **E. Simorangkir, Jakarta Smart City.** [JAKI Punya Info Galian Jalan Jakarta, Cek Dulu Sebelum Berangkat!](https://smartcity.jakarta.go.id/id/blog/09-2026-jaki-punya-info-galian-jalan-jakarta-cek-dulu-sebelum-berangkat/). Article date recorded in the draft: 15 September 2026. Access recorded: 17 September 2026. Use for the road-disruption comparison.
- **Badan Meteorologi, Klimatologi, dan Geofisika.** [Data Peringatan Dini Cuaca Terbuka BMKG](https://data.bmkg.go.id/peringatan-dini-cuaca/). Access recorded: 17 September 2026. Use as an example of an authoritative warning source.

## Software documentation

- **React.** [React documentation](https://react.dev/). Use for the proposed frontend framework.
- **Leaflet.** [Leaflet documentation](https://leafletjs.com/). Use for the interactive map layer.
- **FastAPI.** [FastAPI documentation](https://fastapi.tiangolo.com/). Use for the proposed typed API service.
- **PostGIS.** [PostGIS documentation](https://postgis.net/). Use for spatial storage and queries.
- **LangGraph.** [LangGraph orchestration overview](https://docs.langchain.com/oss/python/langgraph/overview). Use for the proposed stateful agent workflow and checkpoints.
- **pgvector maintainers.** [pgvector documentation](https://github.com/pgvector/pgvector). Reviewed 18 September 2026. Supports the proposed vector storage and semantic retrieval capability; exact search and approximate-index filtering tradeoffs require workload evaluation.
- **PostGIS.** [ST_Intersects](https://postgis.net/docs/ST_Intersects.html). Reviewed 18 September 2026. Supports spatial intersection filtering. Geographic overlap is only a retrieval feature in this design, not proof of incident truth.
- **Pydantic.** [Strict mode](https://docs.pydantic.dev/latest/concepts/strict_mode/). Reviewed 18 September 2026. Relevant to strict service-boundary validation. Schema validation does not establish factual support.

## Architecture framework supplied by the team

- **Building Blocks of AI: Designing an AI-Powered Feature — From Idea to Architecture.** User-supplied infographic, received 18 September 2026. Author, publisher, original publication date and public URL were not supplied. Used for the five layer names and Responsible AI as a cross-cutting concern. Do not invent bibliographic attribution; obtain the original source before adding it to the final bibliography.
- The layered boundaries, budgets, stack selection, ownership, retrieval limits and proposed evaluation gates are project design decisions. They are not claims that the infographic or software documentation prescribes those exact choices. No application implementation or evaluation results are claimed.

## Final citation work

- Decide which claims in the project definition need a source.
- Map each claim to the source that directly supports it.
- Check source independence before describing evidence as corroboration.
- Prepare the university's required bibliography at the end of the report; do not add in-text numerical citations without a new instruction from the user.

## Existing presentation asset

- **Rifki Kurniawan, via Unsplash and UN Indonesia.** Semanggi aerial photograph used in the kickoff deck. Attribution preserved from the existing deck: [UN Global Compact menyatukan sektor swasta China dan Indonesia untuk percepat kemajuan SDG](https://indonesia.un.org/id/296573-un-global-compact-menyatukan-sektor-swasta-china-dan-indonesia-untuk-percepat-kemajuan-sdg). Asset carried forward unchanged in the architecture revision; not newly researched on 18 September 2026.

## Data collection feasibility — discussion on 18 September 2026

- **ANTARA News.** [RSS directory](https://www.antaranews.com/rss?mobile=true). Reviewed 18 September 2026. Starting point for news discovery feeds, including Metro and crime. Feed metadata may require permitted retrieval of the original article for evidence; RSS access does not establish unrestricted article reuse.
- **PetaBencana.** [Laporan Urun-Daya API](https://docs.petabencana.id/routes/laporan-urun-daya). Reviewed 18 September 2026. Documents report retrieval and Jakarta filtering. Preserve observation timestamps and crowdsourced status.
- **Satu Data Jakarta.** [Dashboard Potensi Kelurahan — Bencana Alam dan Mitigasi](https://satudata.jakarta.go.id/dashboard/dashboard-publik/dashboard-potensi-kelurahan?blok=bencana-alam-dan-mitigasi-bencana-alam). Reviewed 18 September 2026. Podes-based historical statistics and a data/metadata download interface; useful as background/reference data. Download contents were not inspected, and this is not a live incident feed.
- **Satu Data Jakarta.** [Dashboard Potensi Kelurahan — Keamanan](https://satudata.jakarta.go.id/dashboard/dashboard-publik/dashboard-potensi-kelurahan?blok=keamanan). Reviewed 18 September 2026. Historical neighbourhood-level security indicators; not a comprehensive current crime-event dataset and not evidence of a present warning zone.
- Collection recommendation: documented API/RSS first, permitted source-page extraction second, and moderator-submitted original URLs where structured access is unavailable. Build a small manually labelled incident corpus for extraction, deduplication and evidence tests; it is an evaluation dataset rather than a requirement to train an LLM from scratch.
- These checks reviewed documentation/pages. They do not replace live connector tests or establish completeness and freshness of every endpoint. Korlantas homepage retrieval through the research tool failed during this check; earlier endpoint findings remain dated as recorded in the source plan.
