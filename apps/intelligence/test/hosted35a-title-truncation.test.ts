/**
 * HOSTED-35a: a public title is cut at a word boundary, with "…", and never longer than its limit. Pure: no database,
 * no network.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { truncateAtWord } from "../src/text-limits.js";

const codePoints = (text: string): number => Array.from(text).length;

describe("HOSTED-35a truncateAtWord", () => {
  it("returns a title unchanged when it fits, including exactly at the limit", () => {
    assert.equal(truncateAtWord("Pohon tumbang", 120), "Pohon tumbang");
    assert.equal(truncateAtWord("abcde", 5), "abcde");
  });

  it("cuts at the last whitespace that fits beside the ellipsis", () => {
    // The first 9 code points are "satu dua ", so the cut is after "dua".
    assert.equal(truncateAtWord("satu dua tiga empat", 10), "satu dua…");
    // The first 19 code points are "Genangan air merend", so the cut is after "air".
    assert.equal(truncateAtWord("Genangan air merendam jalan", 20), "Genangan air…");
  });

  it("drops trailing punctuation left at the cut", () => {
    assert.equal(truncateAtWord("Banjir, Cawang dan Kebon Jeruk", 12), "Banjir…");
  });

  it("hard cuts when there is no usable whitespace, and still drops trailing punctuation", () => {
    assert.equal(truncateAtWord("abcdefghijklmnop", 8), "abcdefg…");
    assert.equal(truncateAtWord("Banjir-banjir-banjir", 8), "Banjir…");
  });

  it("counts code points, so an emoji is one character of the limit", () => {
    const out = truncateAtWord("😀😀😀😀😀😀", 4);
    assert.equal(out, "😀😀😀…");
    assert.equal(codePoints(out), 4);
  });

  it("never exceeds the limit and never cuts a word in the middle", () => {
    const text = "Banjir setinggi lutut merendam permukiman warga di Kebon Jeruk dan Kembangan sejak Senin malam hingga pagi, "
      + "sementara petugas masih memompa air dari sejumlah rumah dan jalan lingkungan di sekitar sungai";
    assert.ok(codePoints(text) > 150, "the fixture is longer than every limit tested");
    for (const max of [10, 20, 40, 60, 120, 150]) {
      const out = truncateAtWord(text, max);
      assert.ok(codePoints(out) <= max, `max ${max}: ${out}`);
      assert.ok(out.endsWith("…"), `max ${max} ends with an ellipsis`);
      const kept = out.slice(0, -1);
      assert.ok(text.startsWith(kept), `max ${max} keeps the start of the text`);
      // The text after the cut starts with a space or punctuation, so no word is split.
      assert.match(text.charAt(kept.length), /[\s\p{P}]/u, `max ${max} stops at a word boundary`);
    }
  });

  it("gives a long summary a title of at most the limit, and the text is a prefix of the summary", () => {
    const summary = "Pohon tumbang menutup jalur di Kebayoran Baru, Jakarta Selatan setelah hujan deras semalam dan membuat arus lalu lintas dari arah Blok M menuju Fatmawati tersendat hingga siang hari";
    const title = truncateAtWord(summary, 120);
    assert.ok(codePoints(title) <= 120);
    assert.ok(title.endsWith("…"));
    assert.ok(summary.startsWith(title.slice(0, -1)));
  });

  it("returns an empty title for a non-positive limit", () => {
    assert.equal(truncateAtWord("Banjir", 0), "");
  });
});
