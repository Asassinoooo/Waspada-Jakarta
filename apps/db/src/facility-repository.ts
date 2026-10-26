import type { SqlExecutor } from "./sql.js";

export interface FacilityRecord {
  readonly id: string;
  readonly source: "osm" | "petabencana";
  readonly kind: "hospital" | "police" | "fire_station";
  readonly title: string;
  readonly coordinates: readonly [longitude: number, latitude: number];
  readonly coordinate_kind: "source_point" | "source_extent_center";
  readonly source_created_at: string | null;
  readonly source_status: string | null;
  readonly source_url: string;
}

export interface FacilityUpsertResult {
  readonly inserted: number;
  readonly updated: number;
}

export interface FacilityRepository {
  seedFacilities(facilities: readonly FacilityRecord[], datasetKind?: string): Promise<number>;
  readAllFacilities(datasetKind?: string): Promise<readonly FacilityRecord[]>;
  upsertFacilityDelta(delta: readonly FacilityRecord[], datasetKind?: string): Promise<FacilityUpsertResult>;
}

const DEFAULT_TRACE_ID = "trace-facility-registry";

export function createFacilityRepository(executor: SqlExecutor): FacilityRepository {
  async function ensureTrace(datasetKind: string, traceId: string = DEFAULT_TRACE_ID): Promise<void> {
    await executor.query(
      `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
       VALUES ($1, $2, now(), 'succeeded', '{"component":"facility-registry"}'::jsonb)
       ON CONFLICT (trace_id) DO NOTHING`,
      [traceId, datasetKind],
    );
  }

  return {
    async seedFacilities(facilities: readonly FacilityRecord[], datasetKind: string = "live"): Promise<number> {
      if (facilities.length === 0) return 0;
      await ensureTrace(datasetKind);

      let count = 0;
      for (const facility of facilities) {
        const geometryId = `geo-${facility.id}`;
        const recordJson = JSON.stringify({
          id: facility.id,
          source: facility.source,
          kind: facility.kind,
          coordinate_kind: facility.coordinate_kind,
          source_created_at: facility.source_created_at,
          source_status: facility.source_status,
          source_url: facility.source_url,
        });

        // waspada.geometries is append-only: on conflict do nothing
        await executor.query(
          `INSERT INTO waspada.geometries (
             dataset_kind, geometry_id, trace_id, role, shape,
             coordinate_reference_system, precision_basis, display_label, record_json
           )
           VALUES (
             $1, $2, $3, 'facility',
             ST_SetSRID(ST_MakePoint($4, $5), 4326),
             'OGC:CRS84', 'source_supplied', $6, $7::jsonb
           )
           ON CONFLICT (dataset_kind, geometry_id) DO NOTHING`,
          [
            datasetKind,
            geometryId,
            DEFAULT_TRACE_ID,
            facility.coordinates[0],
            facility.coordinates[1],
            facility.title,
            recordJson,
          ],
        );
        count += 1;
      }
      return count;
    },

    async readAllFacilities(datasetKind: string = "live"): Promise<readonly FacilityRecord[]> {
      const result = await executor.query<{
        geometry_id: string;
        display_label: string | null;
        lon: number;
        lat: number;
        record_json: {
          id?: string;
          source?: "osm" | "petabencana";
          kind?: "hospital" | "police" | "fire_station";
          coordinate_kind?: "source_point" | "source_extent_center";
          source_created_at?: string | null;
          source_status?: string | null;
          source_url?: string;
        };
      }>(
        `SELECT
           geometry_id,
           display_label,
           ST_X(shape::geometry) AS lon,
           ST_Y(shape::geometry) AS lat,
           record_json
         FROM (
           SELECT DISTINCT ON (COALESCE(record_json->>'id', geometry_id))
             geometry_id,
             display_label,
             shape,
             record_json
           FROM waspada.geometries
           WHERE role = 'facility' AND dataset_kind = $1
           ORDER BY COALESCE(record_json->>'id', geometry_id), geometry_id DESC
         ) latest
         ORDER BY display_label ASC`,
        [datasetKind],
      );

      return result.rows.map((row) => ({
        id: row.record_json?.id ?? row.geometry_id.replace(/^geo-/, ""),
        source: row.record_json?.source ?? "osm",
        kind: row.record_json?.kind ?? "hospital",
        title: row.display_label ?? "Fasilitas",
        coordinates: [Number(row.lon), Number(row.lat)] as const,
        coordinate_kind: row.record_json?.coordinate_kind ?? "source_point",
        source_created_at: row.record_json?.source_created_at ?? null,
        source_status: row.record_json?.source_status ?? null,
        source_url: row.record_json?.source_url ?? "",
      }));
    },

    async upsertFacilityDelta(delta: readonly FacilityRecord[], datasetKind: string = "live"): Promise<FacilityUpsertResult> {
      if (delta.length === 0) return { inserted: 0, updated: 0 };
      await ensureTrace(datasetKind);

      let inserted = 0;
      let updated = 0;

      for (const facility of delta) {
        const recordJson = JSON.stringify({
          id: facility.id,
          source: facility.source,
          kind: facility.kind,
          coordinate_kind: facility.coordinate_kind,
          source_created_at: facility.source_created_at,
          source_status: facility.source_status,
          source_url: facility.source_url,
        });

        // Check if facility already exists
        const checkResult = await executor.query<{
          geometry_id: string;
          display_label: string | null;
          lon: number;
          lat: number;
        }>(
          `SELECT
             geometry_id,
             display_label,
             ST_X(shape::geometry) AS lon,
             ST_Y(shape::geometry) AS lat
           FROM waspada.geometries
           WHERE dataset_kind = $1 AND role = 'facility' AND record_json->>'id' = $2
           ORDER BY geometry_id DESC
           LIMIT 1`,
          [datasetKind, facility.id],
        );

        const existing = checkResult.rows[0];
        if (!existing) {
          // New facility: insert base geometry ID
          const geometryId = `geo-${facility.id}`;
          await executor.query(
            `INSERT INTO waspada.geometries (
               dataset_kind, geometry_id, trace_id, role, shape,
               coordinate_reference_system, precision_basis, display_label, record_json
             )
             VALUES (
               $1, $2, $3, 'facility',
               ST_SetSRID(ST_MakePoint($4, $5), 4326),
               'OGC:CRS84', 'source_supplied', $6, $7::jsonb
             )
             ON CONFLICT (dataset_kind, geometry_id) DO NOTHING`,
            [
              datasetKind,
              geometryId,
              DEFAULT_TRACE_ID,
              facility.coordinates[0],
              facility.coordinates[1],
              facility.title,
              recordJson,
            ],
          );
          inserted += 1;
        } else {
          // Check if changed
          const isSameTitle = existing.display_label === facility.title;
          const isSameCoords = Math.abs(Number(existing.lon) - facility.coordinates[0]) < 0.000001
            && Math.abs(Number(existing.lat) - facility.coordinates[1]) < 0.000001;

          if (!isSameTitle || !isSameCoords) {
            // Append-only revision: insert new versioned geometry row
            const versionedGeometryId = `geo-${facility.id}-v${Date.now()}`;
            await executor.query(
              `INSERT INTO waspada.geometries (
                 dataset_kind, geometry_id, trace_id, role, shape,
                 coordinate_reference_system, precision_basis, display_label, record_json
               )
               VALUES (
                 $1, $2, $3, 'facility',
                 ST_SetSRID(ST_MakePoint($4, $5), 4326),
                 'OGC:CRS84', 'source_supplied', $6, $7::jsonb
               )`,
              [
                datasetKind,
                versionedGeometryId,
                DEFAULT_TRACE_ID,
                facility.coordinates[0],
                facility.coordinates[1],
                facility.title,
                recordJson,
              ],
            );
            updated += 1;
          }
        }
      }

      return { inserted, updated };
    },
  };
}
