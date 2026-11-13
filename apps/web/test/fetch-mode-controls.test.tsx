import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ContextSources } from "../src/ContextSources.js";
import { SourcePreview } from "../src/SourcePreview.js";
import { UnifiedSourceExplorerView, type UnifiedSourceExplorerViewProps } from "../src/UnifiedSourceExplorer.js";

/**
 * The provider fetch controls exist only for a moderator or admin session. A visitor sees a short
 * role note instead, and the controls are absent from the markup.
 */

// Match the button element, so explanatory copy that repeats a label cannot satisfy the check.
const button = (label: string): RegExp => new RegExp(`<button[^>]*>\\s*${label}</button>`, "u");
const explorerContextButton = button("Ambil cuaca &amp; gempa");
const explorerSourceButton = button("Ambil fasilitas &amp; banjir");
const contextPanelButton = button("Ambil konteks cuaca &amp; gempa");
const sourcePanelButton = button("Ambil data sumber");
const roleNote = /moderator atau admin/u;

function explorer(extra: Partial<UnifiedSourceExplorerViewProps> = {}): string {
  return renderToStaticMarkup(createElement(UnifiedSourceExplorerView, {
    datasetMode: "demo",
    sourcePayload: null,
    sourceRequest: { status: "idle" },
    contextPayload: null,
    contextRequest: { status: "idle" },
    onSourceRequest: () => undefined,
    onContextRequest: () => undefined,
    ...extra,
  }));
}

test("the source explorer shows its provider fetch buttons only to a moderator or admin", () => {
  const visitor = explorer();
  assert.doesNotMatch(visitor, explorerContextButton, "visitors get no weather and earthquake fetch");
  assert.doesNotMatch(visitor, explorerSourceButton, "visitors get no facility and flood fetch");
  assert.match(visitor, roleNote);

  const moderator = explorer({ canRequestProviderFetch: true });
  assert.match(moderator, explorerContextButton);
  assert.match(moderator, explorerSourceButton);
  assert.doesNotMatch(moderator, roleNote);
});

test("the context-sources panel shows its provider fetch button only to a moderator or admin", () => {
  const visitor = renderToStaticMarkup(createElement(ContextSources, { datasetMode: "demo" }));
  assert.doesNotMatch(visitor, contextPanelButton);
  assert.match(visitor, roleNote);

  const moderator = renderToStaticMarkup(createElement(ContextSources, { datasetMode: "demo", canRequestProviderFetch: true }));
  assert.match(moderator, contextPanelButton);
});

test("the source-preview panel shows its provider fetch button only to a moderator or admin", () => {
  const visitor = renderToStaticMarkup(createElement(SourcePreview, { datasetMode: "demo" }));
  assert.doesNotMatch(visitor, sourcePanelButton);
  assert.match(visitor, roleNote);

  const moderator = renderToStaticMarkup(createElement(SourcePreview, { datasetMode: "demo", canRequestProviderFetch: true }));
  assert.match(moderator, sourcePanelButton);
});
