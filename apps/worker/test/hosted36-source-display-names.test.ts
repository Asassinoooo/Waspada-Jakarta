/**
 * HOSTED-36 (owner decision, 18 Nov 2026): a structured source's registry name is its outlet name, not its raw id. Pure: no
 * database, no network. The SQL side is apps/db/test/source-display-names.test.ts, which reads migration 058 back.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { BMKG_GEMPA_SOURCE_ID } from "../src/runtime/bmkg-poll-runtime.js";
import { structuredSourceDisplayName } from "../src/runtime/structured-source-display.js";
import { PETABENCANA_SOURCE_ID } from "../src/layers/l1-data-knowledge/petabencana-ingest.js";

test("HOSTED-36: BMKG and PetaBencana rows are named for the outlet, never for the source id", () => {
  assert.equal(structuredSourceDisplayName(BMKG_GEMPA_SOURCE_ID), "BMKG");
  assert.equal(structuredSourceDisplayName(PETABENCANA_SOURCE_ID), "PetaBencana.id");
  assert.notEqual(structuredSourceDisplayName(BMKG_GEMPA_SOURCE_ID), BMKG_GEMPA_SOURCE_ID);
  assert.notEqual(structuredSourceDisplayName(PETABENCANA_SOURCE_ID), PETABENCANA_SOURCE_ID);
});

test("HOSTED-36: any other source id is returned unchanged, so no other caller's name changes", () => {
  assert.equal(structuredSourceDisplayName("source-antara-metro"), "source-antara-metro");
  assert.equal(structuredSourceDisplayName("constructor"), "constructor");
});
