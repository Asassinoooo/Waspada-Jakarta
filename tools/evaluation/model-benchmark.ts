/**
 * Model Evaluation Benchmark Harness (Track 1).
 *
 * Evaluates generative AI incident extraction models across 10 realistic
 * Jakarta emergency scenarios, measuring latency percentiles (p50, p95, avg),
 * token efficiency, citation faithfulness, and toponym coordinate accuracy.
 */

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  createAiProposalService,
  isCoordinateInJakarta,
  type AiProposalService,
  type AiProposalServiceOptions,
} from "../../apps/worker/src/layers/l2-model-grounding/ai-proposal-service.js";
import {
  type StoredReportRevision,
  type StoredEvidenceChunk,
} from "../../apps/worker/src/layers/l2-model-grounding/proposal-engine.js";

export interface BenchmarkScenario {
  readonly id: string;
  readonly title: string;
  readonly expectedCategory: string;
  readonly expectedLocation: string;
  readonly fullText: string;
  readonly chunkTexts: readonly string[];
}

export interface ModelBenchmarkSummary {
  readonly total_scenarios: number;
  readonly latency_ms: { readonly p50: number; readonly p95: number; readonly avg: number };
  readonly tokens: { readonly avg_input: number; readonly avg_output: number };
  readonly citation_faithfulness_rate: number;
  readonly toponym_accuracy_rate: number;
  readonly scenarios: readonly {
    readonly id: string;
    readonly title: string;
    readonly incident_type: string;
    readonly latency_ms: number;
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly citation_match: boolean;
    readonly location_valid: boolean;
  }[];
}

export interface ModelBenchmarkOptions {
  readonly service?: AiProposalService;
  readonly serviceOptions?: AiProposalServiceOptions;
  readonly scenarios?: readonly BenchmarkScenario[];
  readonly verbose?: boolean;
}

/**
 * 10 realistic emergency scenarios across all 5 administrative cities of DKI Jakarta.
 */
export const JAKARTA_BENCHMARK_SCENARIOS: readonly BenchmarkScenario[] = [
  {
    id: "scen-flood-kemang",
    title: "Banjir di Kemang, Jakarta Selatan",
    expectedCategory: "flood",
    expectedLocation: "Kemang, Jakarta Selatan",
    fullText:
      "Hujan deras yang mengguyur wilayah Jakarta Selatan sejak siang menyebabkan banjir setinggi 70 cm di Jalan Kemang Raya, Mampang Prapatan. " +
      "Sejumlah kendaraan bermotor roda dua dan roda empat mogok saat mencoba menerobos genangan air yang meluap dari Kali Krukut. " +
      "Petugas BPBD DKI Jakarta dan personel PPSU dikerahkan ke lokasi untuk membantu evakuasi warga dan menyedot air menggunakan pompa mobile.",
    chunkTexts: [
      "Hujan deras yang mengguyur wilayah Jakarta Selatan sejak siang menyebabkan banjir setinggi 70 cm di Jalan Kemang Raya, Mampang Prapatan.",
      "Sejumlah kendaraan bermotor roda dua dan roda empat mogok saat mencoba menerobos genangan air yang meluap dari Kali Krukut.",
      "Petugas BPBD DKI Jakarta dan personel PPSU dikerahkan ke lokasi untuk membantu evakuasi warga dan menyedot air menggunakan pompa mobile.",
    ],
  },
  {
    id: "scen-fire-senen",
    title: "Kebakaran Kios di Pasar Senen, Jakarta Pusat",
    expectedCategory: "fire",
    expectedLocation: "Pasar Senen, Jakarta Pusat",
    fullText:
      "Kebakaran hebat melanda deretan kios pedagang di kawasan Pasar Senen, Jakarta Pusat pada Selasa dini hari. " +
      "Sebanyak 15 unit mobil pemadam kebakaran beserta 75 personel Sudin Gulkarmat Jakarta Pusat dikerahkan untuk menjinakkan kobaran api. " +
      "Tidak ada korban jiwa dalam musibah kebakaran tersebut, namun kerugian materiil diperkirakan mencapai ratusan juta rupiah.",
    chunkTexts: [
      "Kebakaran hebat melanda deretan kios pedagang di kawasan Pasar Senen, Jakarta Pusat pada Selasa dini hari.",
      "Sebanyak 15 unit mobil pemadam kebakaran beserta 75 personel Sudin Gulkarmat Jakarta Pusat dikerahkan untuk menjinakkan kobaran api.",
      "Tidak ada korban jiwa dalam musibah kebakaran tersebut, namun kerugian materiil diperkirakan mencapai ratusan juta rupiah.",
    ],
  },
  {
    id: "scen-tree-fall-gatot-subroto",
    title: "Pohon Tumbang di Jalan Gatot Subroto, Jakarta Selatan",
    expectedCategory: "tree_fall",
    expectedLocation: "Jalan Gatot Subroto, Jakarta Selatan",
    fullText:
      "Sebuah pohon tumbang di Jalan Gatot Subroto arah Semanggi, Jakarta Selatan menyebabkan kemacetan parah. " +
      "Batang pohon tumbang tersebut menimpa satu unit mobil dan menutup lajur jalan utama. " +
      "Petugas Dinas Pertamanan bergerak cepat mengevakuasi dahan tumbang menggunakan gergaji mesin untuk membuka jalur lalu lintas.",
    chunkTexts: [
      "Sebuah pohon tumbang di Jalan Gatot Subroto arah Semanggi, Jakarta Selatan menyebabkan kemacetan parah.",
      "Batang pohon tumbang tersebut menimpa satu unit mobil dan menutup lajur jalan utama.",
      "Petugas Dinas Pertamanan bergerak cepat mengevakuasi dahan tumbang menggunakan gergaji mesin untuk membuka jalur lalu lintas.",
    ],
  },
  {
    id: "scen-accident-cawang",
    title: "Kecelakaan Beruntun di Simpang Cawang, Jakarta Timur",
    expectedCategory: "accident",
    expectedLocation: "Simpang Cawang, Jakarta Timur",
    fullText:
      "Kecelakaan beruntun melibatkan tiga kendaraan roda empat terjadi di Simpang Cawang arah Tanjung Priok, Jakarta Timur pada jam sibuk pagi hari. " +
      "Dua orang pengemudi dilaporkan mengalami luka parah dan dilarikan ke rumah sakit terdekat untuk mendapatkan perawatan medis darurat. " +
      "Petugas Ditlantas Polda Metro Jaya dan derek Jasa Marga langsung melakukan olah tempat kejadian perkara dan mengevakuasi mobil yang ringsek.",
    chunkTexts: [
      "Kecelakaan beruntun melibatkan tiga kendaraan roda empat terjadi di Simpang Cawang arah Tanjung Priok, Jakarta Timur pada jam sibuk pagi hari.",
      "Dua orang pengemudi dilaporkan mengalami luka parah dan dilarikan ke rumah sakit terdekat untuk mendapatkan perawatan medis darurat.",
      "Petugas Ditlantas Polda Metro Jaya dan derek Jasa Marga langsung melakukan olah tempat kejadian perkara dan mengevakuasi mobil yang ringsek.",
    ],
  },
  {
    id: "scen-flood-pluit",
    title: "Banjir Rob di Pluit, Penjaringan, Jakarta Utara",
    expectedCategory: "flood",
    expectedLocation: "Pluit, Jakarta Utara",
    fullText:
      "Fenomena pasang air laut maksimum memicu banjir rob setinggi 40 cm di kawasan permukiman dan pergudangan Pluit, Penjaringan, Jakarta Utara. " +
      "Genangan air asin merendam akses jalan utama Muara Baru dan pelabuhan perikanan sehingga aktivitas bongkar muat barang terhambat. " +
      "Suku Dinas Sumber Daya Air Jakarta Utara mengoptimalkan operasional seluruh pintu air dan rumah pompa stasioner Waduk Pluit.",
    chunkTexts: [
      "Fenomena pasang air laut maksimum memicu banjir rob setinggi 40 cm di kawasan permukiman dan pergudangan Pluit, Penjaringan, Jakarta Utara.",
      "Genangan air asin merendam akses jalan utama Muara Baru dan pelabuhan perikanan sehingga aktivitas bongkar muat barang terhambat.",
      "Suku Dinas Sumber Daya Air Jakarta Utara mengoptimalkan operasional seluruh pintu air dan rumah pompa stasioner Waduk Pluit.",
    ],
  },
  {
    id: "scen-weather-jagakarsa",
    title: "Cuaca Ekstrem dan Angin Puting Beliung di Jagakarsa, Jakarta Selatan",
    expectedCategory: "weather",
    expectedLocation: "Jagakarsa, Jakarta Selatan",
    fullText:
      "Hujan lebat disertai angin puting beliung menerjang wilayah Jagakarsa, Jakarta Selatan dan mengakibatkan atap puluhan rumah warga rusak. " +
      "Embusan angin kencang juga menumbangkan tiang kabel komunikasi dan baliho di tepi jalan protokol Srengseng Sawah. " +
      "Badan Penanggulangan Bencana Daerah (BPBD) mendirikan posko tanggap darurat dan menyalurkan bantuan logistik terpal serta makanan siap saji.",
    chunkTexts: [
      "Hujan lebat disertai angin puting beliung menerjang wilayah Jagakarsa, Jakarta Selatan dan mengakibatkan atap puluhan rumah warga rusak.",
      "Embusan angin kencang juga menumbangkan tiang kabel komunikasi dan baliho di tepi jalan protokol Srengseng Sawah.",
      "Badan Penanggulangan Bencana Daerah (BPBD) mendirikan posko tanggap darurat dan menyalurkan bantuan logistik terpal serta makanan siap saji.",
    ],
  },
  {
    id: "scen-fire-tambora",
    title: "Kebakaran Permukiman Padat di Kalianyar, Tambora, Jakarta Barat",
    expectedCategory: "fire",
    expectedLocation: "Tambora, Jakarta Barat",
    fullText:
      "Kebakaran melanda permukiman padat penduduk di Kalianyar, Tambora, Jakarta Barat menghanguskan sedikitnya 20 rumah semi permanen warga. " +
      "Akses gang yang sempit sempat menyulitkan petugas pemadam kebakaran menjangkau titik api yang berkobar cepat di lantai dua bangunan kayu. " +
      "Sudin Gulkarmat Jakarta Barat menurunkan 22 unit damkar hingga api berhasil dilokalisasi dan proses pendinginan selesai dalam waktu dua jam.",
    chunkTexts: [
      "Kebakaran melanda permukiman padat penduduk di Kalianyar, Tambora, Jakarta Barat menghanguskan sedikitnya 20 rumah semi permanen warga.",
      "Akses gang yang sempit sempat menyulitkan petugas pemadam kebakaran menjangkau titik api yang berkobar cepat di lantai dua bangunan kayu.",
      "Sudin Gulkarmat Jakarta Barat menurunkan 22 unit damkar hingga api berhasil dilokalisasi dan proses pendinginan selesai dalam waktu dua jam.",
    ],
  },
  {
    id: "scen-flood-kampung-melayu",
    title: "Banjir Luapan Kali Ciliwung di Kampung Melayu, Jakarta Timur",
    expectedCategory: "flood",
    expectedLocation: "Kampung Melayu, Jakarta Timur",
    fullText:
      "Banjir kiriman dari hulu Sungai Ciliwung merendam permukiman warga Kampung Melayu, Jatinegara, Jakarta Timur dengan ketinggian air mencapai 120 cm. " +
      "Pintu Air Manggarai menetapkan status Siaga 2 setelah debit air meluap dan menggenangi ratusan rumah di bantaran kali. " +
      "Tim SAR gabungan mengerahkan perahu karet untuk mengevakuasi lansia dan balita ke tempat pengungsian di kantor kelurahan terdekat.",
    chunkTexts: [
      "Banjir kiriman dari hulu Sungai Ciliwung merendam permukiman warga Kampung Melayu, Jatinegara, Jakarta Timur dengan ketinggian air mencapai 120 cm.",
      "Pintu Air Manggarai menetapkan status Siaga 2 setelah debit air meluap dan menggenangi ratusan rumah di bantaran kali.",
      "Tim SAR gabungan mengerahkan perahu karet untuk mengevakuasi lansia dan balita ke tempat pengungsian di kantor kelurahan terdekat.",
    ],
  },
  {
    id: "scen-tree-fall-kebayoran",
    title: "Pohon Tumbang di Gandaria, Kebayoran Baru, Jakarta Selatan",
    expectedCategory: "tree_fall",
    expectedLocation: "Kebayoran Baru, Jakarta Selatan",
    fullText:
      "Batang pohon tumbang melintang di Jalan Gandaria Raya, Kebayoran Baru, Jakarta Selatan akibat akar yang rapuh. " +
      "Pohon roboh menimpa kabel listrik sehingga terjadi gangguan arus lalu lintas di sekitar lokasi kejadian. " +
      "Petugas pertamanan langsung melakukan evakuasi batang pohon dan dahan patah untuk menormalkan jalan.",
    chunkTexts: [
      "Batang pohon tumbang melintang di Jalan Gandaria Raya, Kebayoran Baru, Jakarta Selatan akibat akar yang rapuh.",
      "Pohon roboh menimpa kabel listrik sehingga terjadi gangguan arus lalu lintas di sekitar lokasi kejadian.",
      "Petugas pertamanan langsung melakukan evakuasi batang pohon dan dahan patah untuk menormalkan jalan.",
    ],
  },
  {
    id: "scen-crime-manggarai",
    title: "Tawuran Remaja di Terowongan Manggarai, Tebet, Jakarta Selatan",
    expectedCategory: "crime",
    expectedLocation: "Manggarai, Jakarta Selatan",
    fullText:
      "Aksi tawuran bersenjata tajam antar dua kelompok remaja pecah di sekitar terowongan Manggarai, Tebet, Jakarta Selatan pada Minggu dini hari. " +
      "Warga yang melintas sempat panik saat kedua kelompok saling melempar batu, petasan, dan mengacungkan senjata tajam di tengah jalan. " +
      "Aparat Polsek Tebet dan Tim Patroli Perintis Presisi Polda Metro Jaya segera tiba di lokasi dan membubarkan kerumunan dengan gas air mata.",
    chunkTexts: [
      "Aksi tawuran bersenjata tajam antar dua kelompok remaja pecah di sekitar terowongan Manggarai, Tebet, Jakarta Selatan pada Minggu dini hari.",
      "Warga yang melintas sempat panik saat kedua kelompok saling melempar batu, petasan, dan mengacungkan senjata tajam di tengah jalan.",
      "Aparat Polsek Tebet dan Tim Patroli Perintis Presisi Polda Metro Jaya segera tiba di lokasi dan membubarkan kerumunan dengan gas air mata.",
    ],
  },
];

function buildReportRevision(scenario: BenchmarkScenario): StoredReportRevision {
  let charOffset = 0;
  const chunks: StoredEvidenceChunk[] = scenario.chunkTexts.map((text, index) => {
    const chunkLength = Array.from(text).length;
    const chunk: StoredEvidenceChunk = {
      chunk_index: index,
      text,
      span_start: charOffset,
      span_end: charOffset + chunkLength,
    };
    charOffset += chunkLength + 1;
    return chunk;
  });

  return {
    report_revision_id: `rev-${scenario.id}`,
    source_id: "antara-metro",
    canonical_url: `https://megapolitan.antaranews.com/berita/${scenario.id}`,
    permitted_text: scenario.fullText,
    permitted_text_hash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    published_at: "2026-10-27T08:00:00.000Z",
    retrieved_at: "2026-10-27T08:05:00.000Z",
    revision_status: "unreviewed",
    chunks,
  };
}

/**
 * Runs the benchmark suite across the 10 emergency scenarios and returns quantitative metrics.
 */
export async function runModelBenchmark(options?: ModelBenchmarkOptions): Promise<ModelBenchmarkSummary> {
  const service = options?.service ?? createAiProposalService(options?.serviceOptions);
  const scenarios = options?.scenarios ?? JAKARTA_BENCHMARK_SCENARIOS;

  const scenarioResults: Array<{
    readonly id: string;
    readonly title: string;
    readonly incident_type: string;
    readonly latency_ms: number;
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly citation_match: boolean;
    readonly location_valid: boolean;
  }> = [];

  for (const scenario of scenarios) {
    const report = buildReportRevision(scenario);
    const result = await service.extractProposal(report);
    const proposal = result.proposal;

    // Check citation match: proposal must have claims, and every claim quote must exist verbatim in a chunk
    const hasClaims = Boolean(proposal && proposal.claims.length > 0);
    const citation_match =
      hasClaims &&
      proposal!.claims.every((claim) =>
        report.chunks.some((chunk) => chunk.text.includes(claim.quote_text)),
      );

    // Check location validity: coordinates must exist and fall strictly within the DKI Jakarta envelope
    const location_valid = Boolean(
      proposal && proposal.coordinates && isCoordinateInJakarta(proposal.coordinates),
    );

    scenarioResults.push({
      id: scenario.id,
      title: proposal?.title ?? scenario.title,
      incident_type: proposal?.incident_type ?? scenario.expectedCategory,
      latency_ms: result.latency_ms,
      input_tokens: result.input_tokens,
      output_tokens: result.output_tokens,
      citation_match,
      location_valid,
    });
  }

  // Calculate latency percentiles using nearest-rank method
  const latencies = [...scenarioResults.map((s) => s.latency_ms)].sort((a, b) => a - b);
  const n = latencies.length;
  const p50 = n > 0 ? latencies[Math.max(0, Math.ceil(0.5 * n) - 1)]! : 0;
  const p95 = n > 0 ? latencies[Math.max(0, Math.ceil(0.95 * n) - 1)]! : 0;
  const avgLatency = n > 0 ? Math.round(latencies.reduce((sum, v) => sum + v, 0) / n) : 0;

  // Calculate token averages
  const totalInputTokens = scenarioResults.reduce((sum, s) => sum + s.input_tokens, 0);
  const totalOutputTokens = scenarioResults.reduce((sum, s) => sum + s.output_tokens, 0);
  const avg_input = n > 0 ? Math.round(totalInputTokens / n) : 0;
  const avg_output = n > 0 ? Math.round(totalOutputTokens / n) : 0;

  // Calculate accuracy rates (0.0 to 1.0)
  const citationMatches = scenarioResults.filter((s) => s.citation_match).length;
  const validLocations = scenarioResults.filter((s) => s.location_valid).length;
  const citation_faithfulness_rate = n > 0 ? Number((citationMatches / n).toFixed(4)) : 0;
  const toponym_accuracy_rate = n > 0 ? Number((validLocations / n).toFixed(4)) : 0;

  return {
    total_scenarios: n,
    latency_ms: { p50, p95, avg: avgLatency },
    tokens: { avg_input, avg_output },
    citation_faithfulness_rate,
    toponym_accuracy_rate,
    scenarios: scenarioResults,
  };
}

function printBenchmarkReport(summary: ModelBenchmarkSummary): void {
  const line = "=".repeat(80);
  const sep = "-".repeat(80);

  process.stdout.write(`\n${line}\n`);
  process.stdout.write("             Waspada Jakarta - Real AI Model Evaluation Benchmark\n");
  process.stdout.write(`${line}\n\n`);

  process.stdout.write(`Total Scenarios: ${summary.total_scenarios}\n`);
  process.stdout.write(
    `Latency (ms):    p50: ${summary.latency_ms.p50} ms | p95: ${summary.latency_ms.p95} ms | avg: ${summary.latency_ms.avg} ms\n`,
  );
  process.stdout.write(
    `Token Usage:     avg input: ${summary.tokens.avg_input} tokens | avg output: ${summary.tokens.avg_output} tokens\n`,
  );
  process.stdout.write(
    `Faithfulness:    Citation: ${(summary.citation_faithfulness_rate * 100).toFixed(1)}% | Toponym: ${(summary.toponym_accuracy_rate * 100).toFixed(1)}%\n\n`,
  );

  process.stdout.write(`${sep}\n`);
  process.stdout.write("Scenario Breakdown:\n");
  process.stdout.write(`${sep}\n`);

  for (let i = 0; i < summary.scenarios.length; i++) {
    const s = summary.scenarios[i]!;
    const citeStatus = s.citation_match ? "PASS" : "FAIL";
    const locStatus = s.location_valid ? "PASS" : "FAIL";
    process.stdout.write(
      `${String(i + 1).padStart(2)}. [${s.incident_type.padEnd(9)}] ${s.id.padEnd(28)} | ${String(s.latency_ms).padStart(3)} ms | in:${String(s.input_tokens).padStart(3)} out:${String(s.output_tokens).padStart(3)} | cite:${citeStatus} loc:${locStatus}\n`,
    );
  }

  process.stdout.write(`${line}\n\n`);
}

function isDirectExecution(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && resolve(entrypoint) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  void runModelBenchmark()
    .then((summary) => {
      printBenchmarkReport(summary);
      process.exitCode = 0;
    })
    .catch((error) => {
      process.stderr.write(`Benchmark error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
