/**
 * HOSTED-35a: an event time is kept only when the report text states it. The publication time is never an event time,
 * and PetaBencana's creation time is not an event time either. Pure: no database, no network.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ReportInterpretation } from "../src/agents/report-interpretation-agent.js";
import {
  BMKG_GEMPA_SOURCE_ID,
  PETABENCANA_SOURCE_ID,
  deterministicStructuredInterpretation,
  groundInterpretationTime,
  statedCalendarDates,
} from "../src/structured-interpretation.js";

type EventTime = ReportInterpretation["eventTime"];

// Published 18 Nov 2026, 10:00 WIB. Most cases use it; the publish-day cases name their own time.
const PUBLISHED_AT = "2026-11-18T03:00:00.000Z";

function withEventTime(eventTime: EventTime): ReportInterpretation {
  return {
    summary: "Banjir setinggi 50 cm di Cawang.",
    incidentType: "banjir",
    severity: "unknown",
    primaryCategory: "disasters_weather",
    location: { label: null, approximateCoordinates: null, precision: "unknown" },
    eventTime,
    entities: [],
    impacts: [],
    operationalStatus: "unknown",
    evidence: [],
    conflictingInfo: [],
    uncertaintyNotes: [],
    confidence: "medium",
  };
}

function ground(eventTime: EventTime, reportText: string, publishedAt: string | null = PUBLISHED_AT): EventTime {
  return groundInterpretationTime(withEventTime(eventTime), reportText, publishedAt).eventTime;
}

const UNKNOWN: EventTime = { value: null, precision: "unknown" };

describe("HOSTED-35a exact event time", () => {
  it("keeps an exact time when the text states the date and the clock time (WIB)", () => {
    const input = withEventTime({ value: "2026-11-17T14:30:00+07:00", precision: "exact" });
    const out = groundInterpretationTime(input, "Banjir setinggi 50 cm di Cawang, Senin (17/11) pukul 14.30 WIB.", PUBLISHED_AT);
    assert.equal(out, input, "nothing changes, so the same object comes back");
  });

  it("gives a zone-less exact value the WIB zone it is written in, so it is not read in the server's local zone", () => {
    assert.deepEqual(
      ground({ value: "2026-11-17T14:30:00", precision: "exact" }, "Banjir di Cawang, 17 November 2026 pukul 14.30."),
      { value: "2026-11-17T14:30:00+07:00", precision: "exact" },
    );
  });

  it("gives unknown for an exact time with a clock time but no stated date: the date would be the model's guess", () => {
    assert.deepEqual(
      ground({ value: "2026-11-17T14:30:00+07:00", precision: "exact" }, "Banjir setinggi 50 cm di Cawang pukul 14.30 WIB."),
      UNKNOWN,
    );
  });

  it("downgrades an exact time to date when only the date is stated", () => {
    assert.deepEqual(
      ground({ value: "2026-11-17T14:30:00+07:00", precision: "exact" }, "Banjir di Cawang pada 17 November 2026."),
      { value: "2026-11-17", precision: "date" },
    );
  });

  it("downgrades to date when the stated date matches but the clock time does not", () => {
    assert.deepEqual(
      ground({ value: "2026-11-17T14:30:00+07:00", precision: "exact" }, "17 November 2026 sekitar pukul 09.00 WIB."),
      { value: "2026-11-17", precision: "date" },
    );
  });

  it("gives unknown when the stated date is a different day from the value", () => {
    assert.deepEqual(
      ground({ value: "2026-11-18T10:00:00+07:00", precision: "exact" }, "Senin (17/11) banjir di Cawang pukul 10.00 WIB.", "2026-11-18T05:00:00.000Z"),
      UNKNOWN,
    );
  });

  it("keeps an exact time with a 'jam ... pagi' or 'jam ... malam' clock", () => {
    assert.deepEqual(
      ground({ value: "2026-11-17T09:00:00+07:00", precision: "exact" }, "Banjir di Cawang, 17 November 2026, jam 9 pagi."),
      { value: "2026-11-17T09:00:00+07:00", precision: "exact" },
    );
    assert.deepEqual(
      ground({ value: "2026-11-17T21:00:00+07:00", precision: "exact" }, "Banjir di Cawang, 17 November 2026, jam 9 malam."),
      { value: "2026-11-17T21:00:00+07:00", precision: "exact" },
    );
  });

  it("reads a stated WITA clock time in WITA, so 14.30 WITA is 13.30 WIB", () => {
    assert.deepEqual(
      ground({ value: "2026-11-17T13:30:00+07:00", precision: "exact" }, "Senin (17/11) pukul 14.30 WITA, banjir di Cawang."),
      { value: "2026-11-17T13:30:00+07:00", precision: "exact" },
    );
    assert.deepEqual(
      ground({ value: "2026-11-17T14:30:00+07:00", precision: "exact" }, "Senin (17/11) pukul 14.30 WITA, banjir di Cawang."),
      { value: "2026-11-17", precision: "date" },
    );
  });

  it("never keeps the publication minute, even when the text prints the same date and time as a dateline", () => {
    const dateline = "Senin, 17 November 2026 pukul 14.30 WIB. Banjir di Cawang.";
    assert.deepEqual(
      ground({ value: "2026-11-17T14:30:00+07:00", precision: "exact" }, dateline, "2026-11-17T07:30:00.000Z"),
      UNKNOWN,
    );
    assert.deepEqual(
      ground({ value: "2026-11-17T14:30:00+07:00", precision: "exact" }, dateline, PUBLISHED_AT),
      { value: "2026-11-17T14:30:00+07:00", precision: "exact" },
      "the same text is kept when the article was published at another time",
    );
  });

  it("gives unknown for an exact value that is not a usable time", () => {
    assert.deepEqual(
      ground({ value: "17 November 2026 14:30 WIB", precision: "exact" }, "Banjir di Cawang, 17 November 2026 pukul 14.30 WIB."),
      UNKNOWN,
    );
  });
});

describe("HOSTED-35a date and range event time", () => {
  it("keeps a date when the text states that calendar date", () => {
    const input = withEventTime({ value: "2026-11-17", precision: "date" });
    assert.equal(groundInterpretationTime(input, "Banjir di Cawang sejak 17 November.", PUBLISHED_AT), input);
  });

  it("gives unknown for a date on the publication day when the text states no date", () => {
    assert.deepEqual(
      ground({ value: "2026-11-18", precision: "date" }, "Banjir setinggi lutut di Cawang.", "2026-11-18T03:00:00.000Z"),
      UNKNOWN,
    );
  });

  it("treats relative words as no stated date", () => {
    assert.deepEqual(ground({ value: "2026-11-17", precision: "date" }, "Banjir di Cawang kemarin malam."), UNKNOWN);
    assert.deepEqual(
      ground({ value: "2026-11-17T14:30:00+07:00", precision: "exact" }, "Banjir di Cawang tadi malam pukul 14.30 WIB."),
      UNKNOWN,
    );
  });

  it("keeps the day of a range when the text states it, and never keeps the span", () => {
    assert.deepEqual(
      ground({ value: "2026-11-17T14:00:00+07:00/2026-11-17T16:00:00+07:00", precision: "range" }, "Hujan deras 17 November 2026 siang hari."),
      { value: "2026-11-17", precision: "date" },
    );
  });

  it("gives unknown for a range the text does not date", () => {
    assert.deepEqual(
      ground({ value: "2026-11-17T14:00:00+07:00/2026-11-17T16:00:00+07:00", precision: "range" }, "Hujan deras siang hari."),
      UNKNOWN,
    );
  });

  it("drops a value that the precision calls unknown, and a null value", () => {
    assert.deepEqual(ground({ value: "2026-11-17", precision: "unknown" }, "Banjir di Cawang, 17 November 2026."), UNKNOWN);
    assert.deepEqual(ground({ value: null, precision: "exact" }, "Banjir di Cawang, 17 November 2026 pukul 14.30 WIB."), UNKNOWN);
  });
});

describe("HOSTED-35a stated calendar dates", () => {
  it("reads the Indonesian and numeric forms, with or without a year", () => {
    assert.deepEqual(statedCalendarDates("Senin (17/11)"), [{ day: 17, month: 11, year: null }]);
    assert.deepEqual(statedCalendarDates("17/11/2026"), [{ day: 17, month: 11, year: 2026 }]);
    assert.deepEqual(statedCalendarDates("18 November 2026"), [{ day: 18, month: 11, year: 2026 }]);
    assert.deepEqual(statedCalendarDates("pada 17 Nov."), [{ day: 17, month: 11, year: null }]);
    assert.deepEqual(statedCalendarDates("17-11-2026"), [{ day: 17, month: 11, year: 2026 }]);
  });

  it("ignores relative words, ISO timestamps and impossible dates", () => {
    assert.deepEqual(statedCalendarDates("kemarin, tadi malam, hari ini"), []);
    assert.deepEqual(statedCalendarDates("Waktu pembuatan laporan: 2026-11-16T10:00:00Z."), []);
    assert.deepEqual(statedCalendarDates("31/02"), []);
  });
});

describe("HOSTED-35a structured sources", () => {
  it("PetaBencana: the creation time is not an event time, so the precision is unknown", () => {
    const text = "Laporan banjir PetaBencana ID 123: status laporan verified. Koordinat lokasi [106.85000, -6.21000]. Waktu pembuatan laporan: 2026-11-16T10:00:00Z.";
    const interpretation = deterministicStructuredInterpretation({
      sourceId: PETABENCANA_SOURCE_ID,
      reportText: text,
      evidenceChunks: [{ chunkId: "chunk-pb", text }],
    });
    assert.ok(interpretation);
    assert.deepEqual(interpretation.eventTime, { value: null, precision: "unknown" });
    assert.ok(
      interpretation.uncertaintyNotes.includes("Waktu kejadian tidak dinyatakan sumber; waktu pembuatan laporan bukan waktu kejadian."),
    );
  });

  it("PetaBencana without a creation time stays unknown too", () => {
    const text = "Laporan banjir PetaBencana ID 124: status laporan verified.";
    const interpretation = deterministicStructuredInterpretation({
      sourceId: PETABENCANA_SOURCE_ID,
      reportText: text,
      evidenceChunks: [{ chunkId: "chunk-pb-2", text }],
    });
    assert.deepEqual(interpretation?.eventTime, { value: null, precision: "unknown" });
  });

  it("BMKG keeps an unknown time, since its text has none", () => {
    const text = "[106.84, -6.21] BMKG: Gempa bumi M 5.2 di 80 km Barat Daya Sukabumi, kedalaman 10 km.";
    const interpretation = deterministicStructuredInterpretation({
      sourceId: BMKG_GEMPA_SOURCE_ID,
      reportText: text,
      evidenceChunks: [{ chunkId: "chunk-bmkg", text }],
    });
    assert.deepEqual(interpretation?.eventTime, { value: null, precision: "unknown" });
  });
});
