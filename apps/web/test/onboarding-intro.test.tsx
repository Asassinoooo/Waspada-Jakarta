import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { HelpPage } from "../src/HelpPage.js";
import {
  INTRO_OPEN_EVENT,
  INTRO_STEPS,
  INTRO_STORAGE_KEY,
  OnboardingIntro,
  OnboardingIntroPanel,
  introAutoOpenFor,
  isIntroDone,
  markIntroDone,
  openOnboardingIntro,
  resetIntroSessionForTests,
  type IntroStorage,
} from "../src/OnboardingIntro.js";

class MemoryIntroStorage implements IntroStorage {
  readonly values = new Map<string, string>();

  constructor(private readonly blocked = false) {}

  getItem(key: string): string | null {
    if (this.blocked) throw new Error("storage blocked");
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.blocked) throw new Error("storage blocked");
    this.values.set(key, value);
  }
}

test("intro has three steps whose copy keeps the emergency and no-safety-claim limits", () => {
  assert.equal(INTRO_STEPS.length, 3);
  const text = INTRO_STEPS.flatMap((step) => [step.title, ...step.paragraphs]).join("\n");

  assert.match(text, /bukan layanan darurat/u);
  assert.match(text, /112/u);
  assert.match(text, /Jumlah laporan bukan bukti kebenaran/u);
  assert.match(text, /perlu pembaruan/u);
  assert.match(text, /sumber yang disebutkan/u);
  assert.match(text, /Area saya/u);
  assert.doesNotMatch(text, /\b(ini|itu) aman\b/iu, "no area is described as safe");

  // Any sentence that mentions "aman" must deny it, so no sentence claims that a place is safe.
  const sentences = text.split(/(?<=[.!?])\s+/u).filter((sentence) => /\baman\b/iu.test(sentence));
  assert.ok(sentences.length > 0);
  for (const sentence of sentences) {
    assert.match(sentence, /\b(tidak|bukan|belum)\b/iu, sentence);
  }
});

test("intro panel shows the current step with skip and advance controls", () => {
  const first = renderToStaticMarkup(<OnboardingIntroPanel step={0} onSkip={() => {}} onAdvance={() => {}} />);
  assert.match(first, /Apa itu Waspada Jakarta/u);
  assert.match(first, /id="onboarding-intro-title"/u);
  assert.match(first, />Lewati</u);
  assert.match(first, />Lanjut</u);
  assert.match(first, /Langkah 1 dari 3/u);
  assert.equal((first.match(/aria-current="step"/gu) ?? []).length, 1);

  const second = renderToStaticMarkup(<OnboardingIntroPanel step={1} onSkip={() => {}} onAdvance={() => {}} />);
  assert.match(second, /Membaca peta dan bukti/u);

  const last = renderToStaticMarkup(<OnboardingIntroPanel step={2} onSkip={() => {}} onAdvance={() => {}} />);
  assert.match(last, /Simpan area Anda/u);
  assert.match(last, />Mulai</u);
  assert.doesNotMatch(last, />Lanjut</u);
  assert.match(last, /Langkah 3 dari 3/u);
});

test("intro renders nothing on the server until it is opened", () => {
  assert.equal(renderToStaticMarkup(<OnboardingIntro autoOpen />), "");
  assert.equal(renderToStaticMarkup(<OnboardingIntro />), "");
});

test("intro auto-opens only on the public map", () => {
  assert.equal(introAutoOpenFor("discover"), true);
  for (const screen of ["admin", "review", "pipeline-flow", "source-preview", "login", "onboarding", "account", "help", "preferences", "updates", "embedding-3d"]) {
    assert.equal(introAutoOpenFor(screen), false, screen);
  }
});

test("dismissal is stored under the v1 key and stays closed on later visits", () => {
  resetIntroSessionForTests();
  const storage = new MemoryIntroStorage();
  assert.equal(INTRO_STORAGE_KEY, "waspada-jakarta:intro:v1");
  assert.equal(isIntroDone(storage), false);

  markIntroDone(storage);
  assert.equal(storage.values.get(INTRO_STORAGE_KEY), "done");

  resetIntroSessionForTests();
  assert.equal(isIntroDone(storage), true, "a new page session reads the stored value");
  resetIntroSessionForTests();
});

test("blocked storage never throws and the intro still shows only once per page session", () => {
  resetIntroSessionForTests();
  const blocked = new MemoryIntroStorage(true);
  assert.doesNotThrow(() => isIntroDone(blocked));
  assert.equal(isIntroDone(blocked), false);
  assert.doesNotThrow(() => markIntroDone(blocked));
  assert.equal(isIntroDone(blocked), true, "the module flag remembers the dismissal for this page session");
  resetIntroSessionForTests();
  assert.equal(isIntroDone(null), false, "with no storage at all the intro shows again on a new page session");
});

test("the intro can be reopened from the help page and from the shell", () => {
  const help = renderToStaticMarkup(<HelpPage />);
  assert.match(help, /Lihat pengenalan lagi/u);
  assert.equal(INTRO_OPEN_EVENT, "waspada:open-intro");
  // Outside the browser the request is a no-op rather than a crash.
  assert.doesNotThrow(() => openOnboardingIntro());
});
