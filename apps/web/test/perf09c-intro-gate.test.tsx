import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OnboardingIntroGate } from "../src/OnboardingIntroGate.js";
import { INTRO_OPEN_EVENT, openOnboardingIntro } from "../src/intro-trigger.js";
import * as intro from "../src/OnboardingIntro.js";

/** PERF-09c: the intro dialog is lazy; the entry chunk keeps only the trigger helpers. */

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("gate renders nothing until the intro is needed", () => {
  assert.equal(renderToStaticMarkup(createElement(OnboardingIntroGate, { autoOpen: true })), "");
  assert.equal(renderToStaticMarkup(createElement(OnboardingIntroGate, { autoOpen: false })), "");
});

test("entry modules import the trigger, never the dialog module, statically", () => {
  for (const file of ["../src/App.tsx", "../src/AppShell.tsx", "../src/HelpPage.tsx", "../src/OnboardingIntroGate.tsx"]) {
    assert.doesNotMatch(source(file), /^import[^;]*from "\.\/OnboardingIntro\.js";/mu, file);
  }
  assert.match(source("../src/OnboardingIntroGate.tsx"), /lazy\(\(\) => import\("\.\/OnboardingIntro\.js"\)/u);
});

test("dialog module still re-exports the trigger API", () => {
  assert.equal(intro.INTRO_OPEN_EVENT, INTRO_OPEN_EVENT);
  assert.equal(intro.openOnboardingIntro, openOnboardingIntro);
});

test("openOnMount opens the dialog on first render", () => {
  const html = renderToStaticMarkup(createElement(intro.OnboardingIntro, { openOnMount: true }));
  assert.match(html, /onboarding-intro-title/u);
  assert.match(html, new RegExp(intro.INTRO_STEPS[0]!.title));
});
