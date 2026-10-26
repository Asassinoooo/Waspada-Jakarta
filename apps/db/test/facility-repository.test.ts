import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { applyMigrations, readMigrations } from "../src/migrations.js";
import {
  createFacilityRepository,
  type FacilityRecord,
} from "../src/facility-repository.js";
import { createTestDatabase, type TestDatabase } from "./harness.js";

describe("FACILITY-REPO: durable facility registry storage", () => {
  let database: TestDatabase;
  let repo: ReturnType<typeof createFacilityRepository>;

  const sampleFacilities: FacilityRecord[] = [
    {
      id: "osm:node/1001",
      source: "osm",
      kind: "hospital",
      title: "RSUPN Dr. Cipto Mangunkusumo",
      coordinates: [106.8486, -6.1966],
      coordinate_kind: "source_point",
      source_created_at: null,
      source_status: null,
      source_url: "https://www.openstreetmap.org/node/1001",
    },
    {
      id: "osm:node/1002",
      source: "osm",
      kind: "police",
      title: "Polda Metro Jaya",
      coordinates: [106.8123, -6.2234],
      coordinate_kind: "source_point",
      source_created_at: null,
      source_status: null,
      source_url: "https://www.openstreetmap.org/node/1002",
    },
    {
      id: "osm:way/2001",
      source: "osm",
      kind: "fire_station",
      title: "Dinas Gulkarmat DKI Jakarta",
      coordinates: [106.8341, -6.1754],
      coordinate_kind: "source_extent_center",
      source_created_at: null,
      source_status: null,
      source_url: "https://www.openstreetmap.org/way/2001",
    },
  ];

  before(async () => {
    database = await createTestDatabase();
    repo = createFacilityRepository(database.executor);
    const migrations = await readMigrations(new URL("../migrations/", import.meta.url));
    await applyMigrations(database.executor, migrations);
  });

  after(async () => {
    await database.close();
  });

  it("seeds facilities into waspada.geometries and reads them back", async () => {
    const seededCount = await repo.seedFacilities(sampleFacilities, "live");
    assert.equal(seededCount, 3);

    const facilities = await repo.readAllFacilities("live");
    assert.equal(facilities.length, 3);

    const rscm = facilities.find((f) => f.id === "osm:node/1001");
    assert.ok(rscm);
    assert.equal(rscm.title, "RSUPN Dr. Cipto Mangunkusumo");
    assert.equal(rscm.kind, "hospital");
    assert.ok(Math.abs(rscm.coordinates[0] - 106.8486) < 0.0001);
    assert.ok(Math.abs(rscm.coordinates[1] - (-6.1966)) < 0.0001);

    const polda = facilities.find((f) => f.id === "osm:node/1002");
    assert.ok(polda);
    assert.equal(polda.kind, "police");

    const damkar = facilities.find((f) => f.id === "osm:way/2001");
    assert.ok(damkar);
    assert.equal(damkar.kind, "fire_station");
  });

  it("upserts delta with new and updated facilities correctly", async () => {
    const delta: FacilityRecord[] = [
      {
        id: "osm:node/1001",
        source: "osm",
        kind: "hospital",
        title: "RSUPN Dr. Cipto Mangunkusumo (Gedung A)",
        coordinates: [106.8488, -6.1968],
        coordinate_kind: "source_point",
        source_created_at: null,
        source_status: null,
        source_url: "https://www.openstreetmap.org/node/1001",
      },
      {
        id: "osm:node/1003",
        source: "osm",
        kind: "hospital",
        title: "RSUD Pasar Minggu",
        coordinates: [106.8256, -6.2974],
        coordinate_kind: "source_point",
        source_created_at: null,
        source_status: null,
        source_url: "https://www.openstreetmap.org/node/1003",
      },
    ];

    const result = await repo.upsertFacilityDelta(delta, "live");
    assert.equal(result.updated, 1);
    assert.equal(result.inserted, 1);

    const all = await repo.readAllFacilities("live");
    assert.equal(all.length, 4);

    const updatedRscm = all.find((f) => f.id === "osm:node/1001");
    assert.equal(updatedRscm?.title, "RSUPN Dr. Cipto Mangunkusumo (Gedung A)");

    const newRsud = all.find((f) => f.id === "osm:node/1003");
    assert.ok(newRsud);
    assert.equal(newRsud.title, "RSUD Pasar Minggu");
  });
});
