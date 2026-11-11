import type { SqlExecutor, SqlResult } from "../../../../db/src/sql.js";
import type { DatasetKind } from "../../../../db/src/ports.js";
import type { WorkerEnvironment } from "./api.js";

export const EMBEDDING_VISUALIZATION_ROUTE_PATH = "/api/v1/embeddings/visualization";

export interface EmbeddingVisualizationItemDto {
  readonly embeddingRunId: string;
  readonly chunkId: string;
  readonly reportRevisionId: string;
  readonly sourceId: string;
  readonly canonicalUrl: string | null;
  readonly title: string;
  readonly createdAt: string;
  readonly vector: readonly number[];
}

export interface EmbeddingVisualizationResponseDto {
  readonly total: number;
  readonly dimensions: number;
  readonly datasetKind: string;
  readonly items: readonly EmbeddingVisualizationItemDto[];
}
interface EmbeddingQueryResultRow {
  readonly embedding_run_id: string;
  readonly chunk_id: string;
  readonly dimensions: number;
  readonly created_at: string;
  readonly report_revision_id: string;
  readonly span_start: number;
  readonly span_end: number;
  readonly source_id: string;
  readonly canonical_url: string | null;
  readonly title: string | null;
  readonly vector_str: string;
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
} as const;

function parseVector(vectorStr: string): number[] {
  const trimmed = vectorStr.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const raw = trimmed.slice(1, -1);
    const parts = raw.split(",");
    const result: number[] = new Array(parts.length);
    for (let i = 0; i < parts.length; i++) {
      const parsed = Number.parseFloat(parts[i].trim());
      result[i] = Number.isNaN(parsed) ? 0 : parsed;
    }
    return result;
  }
  return [];
}

/**
 * Deterministic PRNG for synthetic embedding vectors in demo/test environments.
 */
function createDeterministicRandom(seed: number) {
  let state = seed % 2147483647;
  if (state <= 0) state += 2147483646;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

function generateSyntheticVector(centroidSeed: number, pointSeed: number, dims: number = 768): number[] {
  const rndCentroid = createDeterministicRandom(centroidSeed);
  const rndPerturb = createDeterministicRandom(pointSeed);
  const vec = new Float64Array(dims);
  let normSq = 0;
  for (let i = 0; i < dims; i++) {
    const c = (rndCentroid() - 0.5) * 2;
    const p = (rndPerturb() - 0.5) * 0.4;
    const val = c + p;
    vec[i] = val;
    normSq += val * val;
  }
  const norm = Math.sqrt(normSq) || 1;
  const result: number[] = new Array(dims);
  for (let i = 0; i < dims; i++) {
    result[i] = Number((vec[i] / norm).toFixed(6));
  }
  return result;
}

export function generateSyntheticEmbeddingDataset(dims: number = 768): readonly EmbeddingVisualizationItemDto[] {
  const clusters = [
    {
      sourceId: "source-petabencana-reports",
      topic: "Banjir & Cuaca Ekstrem",
      seed: 101,
      samples: [
        { title: "Banjir Luapan Kali Ciliwung Merendam Rawajati", text: "Air setinggi 60 cm mulai menggenangi pemukiman warga di RT 03 RW 07 Kelurahan Rawajati sejak dini hari." },
        { title: "Genangan Air di Jalan MT Haryono Mencapai 40 cm", text: "Arus lalu lintas tersendat akibat genangan air setinggi 40 cm di depan Gedung Menara Hijau arah Pancoran." },
        { title: "BPBD DKI Laporkan 12 RT di Jakarta Timur Tergenang", text: "Hujan deras sejak malam memicu luapan kali di Kampung Melayu dan Bidara Cina, 12 RT terdampak." },
        { title: "Pintu Air Manggarai Berstatus Siaga 3", text: "Tinggi muka air di Pintu Air Manggarai mencapai 780 cm pada pukul 06.00 WIB dengan cuaca mendung tipis." },
        { title: "Pompa Air Pasar Minggu Diaktifkan Maksimal", text: "Suku Dinas SDA Jakarta Selatan mengoperasikan lima unit pompa stasioner guna menyedot genangan di terowongan." },
        { title: "Pohon Tumbang Hambat Jalur Busway Ragunan", text: "Sebuah pohon beringin berdiameter 80 cm tumbang akibat angin kencang di kawasan Ragunan Jakarta Selatan." },
        { title: "Peringatan Dini Cuaca BMKG untuk Wilayah Jabodetabek", text: "BMKG mengeluarkan peringatan potensi hujan lebat disertai kilat dan angin kencang di Jakbar, Jaksel, dan Jaktim." },
      ],
    },
    {
      sourceId: "source-antara-metro",
      topic: "Kebakaran & Gangguan Listrik",
      seed: 202,
      samples: [
        { title: "Kebakaran Melanda Permukiman Padat di Johar Baru", text: "Sebanyak 18 unit mobil damkar diterjunkan memadamkan api yang melalap delapan rumah di Jalan Galur Sari." },
        { title: "Gardu Listrik Gandaria Meledak Padamkan Aliran 4 RW", text: "Ledakan pada trafo gardu induk mengakibatkan pemadaman listrik sementara di wilayah Gandaria Utara." },
        { title: "Damkar Jakbar Berhasil Jinakkan Api Ruko Glodok", text: "Petugas pemadam kebakaran berhasil melokalisasi kobaran api di lantai dua pertokoan elektronik Glodok." },
        { title: "Korsleting Listrik Diduga Pemicu Api Pasar Kambing", text: "Hasil olah TKP sementara menunjukkan percikan api berasal dari instalasi kabel lantai mezanin." },
        { title: "Asap Tebal Selimuti Jalur Layang Tol Slipi", text: "Pembakaran sampah ilegal di kolong flyover menyebabkan asap tebal yang mengganggu jarak pandang pengendara." },
        { title: "Kebakaran Gudang Kayu di Cakung Butuh 2 Jam Pemadaman", text: "Material kayu kering membuat api cepat membesar sebelum akhirnya berhasil didinginkan 14 unit pompa." },
      ],
    },
    {
      sourceId: "source-tempo-metro",
      topic: "Kemacetan & Insiden Transportasi",
      seed: 303,
      samples: [
        { title: "Truk Kontainer Mogok di Tol Cawang Arah Semanggi", text: "Kepadatan kendaraan mengular hingga 4 kilometer akibat truk tronton mengalami patah as roda di lajur tengah." },
        { title: "KRL Lintas Bogor Mengalami Antrean Masuk Manggarai", text: "KAI Commuter menerapkan rekayasa pola operasi sementara menyusul perbaikan wesel stasiun Manggarai." },
        { title: "Kecelakaan Beruntun Tiga Mobil di Tol Dalam Kota Tomang", text: "Kecelakaan melibatkan minibus dan dua sedan di KM 13 arah Grogol, tidak ada korban jiwa dilaporkan." },
        { title: "Pengalihan Arus Lalu Lintas Seputar Bundaran HI", text: "Ditlantas Polda Metro Jaya memberlakukan rekayasa lalu lintas sehubungan kegiatan marathon akhir pekan." },
        { title: "Genangan Jalur Lambat Sudirman Hambat Sepeda Motor", text: "Pengendara roda dua terpaksa melambat melintasi genangan sedalam 20 cm di depan Plaza Sentral." },
        { title: "Transjakarta Koridor 1 Beroperasi Normal Pasca Rekayasa", text: "Layanan koridor Blok M - Kota telah kembali ke rute reguler setelah penanganan pohon tumbang rampung." },
      ],
    },
  ];

  const items: EmbeddingVisualizationItemDto[] = [];
  let index = 0;
  for (const cluster of clusters) {
    for (let s = 0; s < cluster.samples.length; s++) {
      index++;
      const sample = cluster.samples[s];
      items.push({
        embeddingRunId: `emb-demo-${cluster.seed}-${index}`,
        chunkId: `chk-demo-${cluster.seed}-${index}`,
        reportRevisionId: `rep-demo-${cluster.seed}-${index}`,
        sourceId: cluster.sourceId,
        canonicalUrl: `https://example.com/demo/${cluster.seed}/${index}`,
        title: sample.title,
        createdAt: new Date(Date.now() - index * 3600000).toISOString(),
        vector: generateSyntheticVector(cluster.seed, cluster.seed * 1000 + index, dims),
      });
    }
  }
  return items;
}

export type SqlExecutorRunner = <Result>(
  env: WorkerEnvironment,
  operation: (executor: SqlExecutor) => Promise<Result>,
) => Promise<Result>;

export function createEmbeddingVisualizationHandler(options: {
  executorRunner?: SqlExecutorRunner;
} = {}) {
  return async (request: Request, env: WorkerEnvironment): Promise<Response> => {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: JSON_HEADERS });
    }
    if (request.method !== "GET") {
      return new Response(JSON.stringify({ error: "Method not allowed", message: "Only GET is supported" }), {
        status: 405,
        headers: { ...JSON_HEADERS, allow: "GET, OPTIONS" },
      });
    }

    const url = new URL(request.url);
    const limitParam = Number.parseInt(url.searchParams.get("limit") || "200", 10);
    const limit = Number.isNaN(limitParam) ? 200 : Math.max(1, Math.min(500, limitParam));
    // The dataset is server-selected from DATASET_MODE. Query parameters cannot choose it.
    const datasetKind: DatasetKind = env.DATASET_MODE === "live" ? "live" : "synthetic";

    const executeQuery = async (executor: SqlExecutor) => {
      const query = `
        SELECT
          r.embedding_run_id,
          r.chunk_id,
          r.dimensions,
          r.created_at,
          c.report_revision_id,
          c.span_start,
          c.span_end,
          rev.source_id,
          rev.canonical_url,
          substr(rev.permitted_text, 1, 100) AS title,
          v.embedding::text AS vector_str
        FROM waspada.embedding_runs r
        JOIN waspada.embedding_vectors v
          ON v.dataset_kind = r.dataset_kind AND v.embedding_run_id = r.embedding_run_id
        JOIN waspada.evidence_chunks c
          ON c.dataset_kind = r.dataset_kind AND c.chunk_id = r.chunk_id
        JOIN waspada.report_revisions rev
          ON rev.dataset_kind = c.dataset_kind AND rev.report_revision_id = c.report_revision_id
        WHERE r.dataset_kind = $1 AND r.status = 'available'
        ORDER BY r.created_at DESC
        LIMIT $2
      `;
      return executor.query<EmbeddingQueryResultRow>(query, [datasetKind, limit]);
    };

    try {
      let res: SqlResult<EmbeddingQueryResultRow> | null = null;

      if (options.executorRunner) {
        res = await options.executorRunner(env, executeQuery);
      } else if (env.SQL_EXECUTOR) {
        res = await executeQuery(env.SQL_EXECUTOR);
      }

      if (res && res.rows.length > 0) {
        const items: EmbeddingVisualizationItemDto[] = res.rows.map((row) => ({
          embeddingRunId: row.embedding_run_id,
          chunkId: row.chunk_id,
          reportRevisionId: row.report_revision_id,
          sourceId: row.source_id,
          canonicalUrl: row.canonical_url,
          title: (row.title || "").trim(),
          createdAt: typeof row.created_at === "string" ? row.created_at : new Date(row.created_at).toISOString(),
          vector: parseVector(row.vector_str),
        }));

        const responseData: EmbeddingVisualizationResponseDto = {
          total: items.length,
          dimensions: res.rows[0].dimensions || 768,
          datasetKind,
          items,
        };

        return new Response(JSON.stringify(responseData), {
          status: 200,
          headers: JSON_HEADERS,
        });
      }
    } catch {
      // Fall through to synthetic fallback
    }

    // Demo / offline fallback dataset
    const syntheticItems = generateSyntheticEmbeddingDataset(768);
    const fallbackResponse: EmbeddingVisualizationResponseDto = {
      total: syntheticItems.length,
      dimensions: 768,
      datasetKind: "synthetic",
      items: syntheticItems.slice(0, limit),
    };

    return new Response(JSON.stringify(fallbackResponse), {
      status: 200,
      headers: JSON_HEADERS,
    });
  };
}
