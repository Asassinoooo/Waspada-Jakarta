import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FOCUSABLE_SELECTOR, isDismissKey, nextRovingIndex, trapFocusIndex } from "../src/ui/a11y.js";
import { Dialog } from "../src/ui/Dialog.js";
import { Menu } from "../src/ui/Menu.js";
import { Popover } from "../src/ui/Popover.js";
import { Sheet } from "../src/ui/Sheet.js";
import { TabPanel, Tabs } from "../src/ui/Tabs.js";

test("roving index wraps the arrow keys and jumps with Home and End", () => {
  assert.equal(nextRovingIndex("ArrowRight", 0, 3, "horizontal"), 1);
  assert.equal(nextRovingIndex("ArrowRight", 2, 3, "horizontal"), 0, "forward wraps to the first item");
  assert.equal(nextRovingIndex("ArrowLeft", 0, 3, "horizontal"), 2, "backward wraps to the last item");
  assert.equal(nextRovingIndex("ArrowLeft", 1, 3, "horizontal"), 0);
  assert.equal(nextRovingIndex("Home", 2, 3, "horizontal"), 0);
  assert.equal(nextRovingIndex("End", 0, 3, "horizontal"), 2);
  assert.equal(nextRovingIndex("ArrowDown", 0, 3, "vertical"), 1);
  assert.equal(nextRovingIndex("ArrowUp", 0, 3, "vertical"), 2);
});

test("roving index ignores keys outside its axis and empty or unselected groups", () => {
  assert.equal(nextRovingIndex("ArrowDown", 0, 3, "horizontal"), null);
  assert.equal(nextRovingIndex("ArrowRight", 0, 3, "vertical"), null);
  assert.equal(nextRovingIndex("Enter", 0, 3, "horizontal"), null);
  assert.equal(nextRovingIndex("ArrowRight", 0, 0, "horizontal"), null);
  assert.equal(nextRovingIndex("ArrowRight", -1, 3, "horizontal"), 0, "nothing selected: start at the first item");
  assert.equal(nextRovingIndex("ArrowLeft", -1, 3, "horizontal"), 2, "nothing selected: start at the last item");
});

test("focus trap stays inside the list in both directions and recovers from focus outside it", () => {
  assert.equal(trapFocusIndex(0, 3, false), 1);
  assert.equal(trapFocusIndex(2, 3, false), 0);
  assert.equal(trapFocusIndex(0, 3, true), 2);
  assert.equal(trapFocusIndex(2, 3, true), 1);
  assert.equal(trapFocusIndex(-1, 3, false), 0);
  assert.equal(trapFocusIndex(-1, 3, true), 2);
  assert.equal(trapFocusIndex(0, 0, false), -1);
});

test("dismiss keys and the focusable selector cover Escape and the interactive elements", () => {
  assert.equal(isDismissKey("Escape"), true);
  assert.equal(isDismissKey("Esc"), true);
  assert.equal(isDismissKey("Enter"), false);
  for (const part of ["a[href]", "button:not([disabled])", "input:not([disabled])", "select:not([disabled])", "textarea:not([disabled])"]) {
    assert.match(FOCUSABLE_SELECTOR, new RegExp(part.replace(/[[\]()*+?.^$|{}\\]/gu, "\\$&"), "u"));
  }
});

test("dialog renders a modal surface named by its heading and nothing while closed", () => {
  assert.equal(renderToStaticMarkup(<Dialog open={false} onClose={() => {}} titleId="closed-title"><p>Tertutup</p></Dialog>), "");
  const markup = renderToStaticMarkup(
    <Dialog open onClose={() => {}} titleId="dialog-title" className="extra-surface">
      <h2 id="dialog-title">Judul dialog</h2>
      <button type="button">Tutup</button>
    </Dialog>,
  );
  assert.match(markup, /class="modal-overlay ui-overlay"/u);
  assert.match(markup, /role="dialog"/u);
  assert.match(markup, /aria-modal="true"/u);
  assert.match(markup, /aria-labelledby="dialog-title"/u);
  assert.match(markup, /class="modal-dialog ui-dialog extra-surface"/u);
  assert.match(markup, /Judul dialog/u);
});

test("sheet uses the requested side and keeps the same dialog semantics", () => {
  assert.equal(renderToStaticMarkup(<Sheet open={false} onClose={() => {}} titleId="sheet-title"><p>Tertutup</p></Sheet>), "");
  const left = renderToStaticMarkup(<Sheet open side="left" onClose={() => {}} titleId="sheet-title"><h2 id="sheet-title">Laci</h2></Sheet>);
  assert.match(left, /class="sheet-overlay sheet-overlay--left"/u);
  assert.match(left, /role="dialog"/u);
  assert.match(left, /aria-modal="true"/u);
  assert.match(left, /aria-labelledby="sheet-title"/u);
  const defaultSide = renderToStaticMarkup(<Sheet open onClose={() => {}} titleId="sheet-title"><h2 id="sheet-title">Laci</h2></Sheet>);
  assert.match(defaultSide, /class="sheet-overlay sheet-overlay--right"/u);
});

test("tabs expose a tablist with roving tabindex and aria-selected on the chosen tab", () => {
  const tabs = [
    { id: "ringkasan", label: "Ringkasan" },
    { id: "tinjau", label: "Tinjau" },
    { id: "alur", label: "Alur" },
  ];
  const markup = renderToStaticMarkup(<Tabs idPrefix="admin" label="Bagian admin" tabs={tabs} value="tinjau" onChange={() => {}} />);
  assert.match(markup, /role="tablist" aria-label="Bagian admin"/u);
  assert.equal((markup.match(/role="tab"/gu) ?? []).length, 3);

  const selected = markup.match(/<button[^>]*id="admin-tab-tinjau"[^>]*>/u)?.[0] ?? "";
  assert.match(selected, /aria-selected="true"/u);
  assert.match(selected, /tabindex="0"/u);
  assert.match(selected, /aria-controls="admin-panel-tinjau"/u);

  const other = markup.match(/<button[^>]*id="admin-tab-ringkasan"[^>]*>/u)?.[0] ?? "";
  assert.match(other, /aria-selected="false"/u);
  assert.match(other, /tabindex="-1"/u);
});

test("tab panels are labelled by their tab and hidden while inactive", () => {
  const inactive = renderToStaticMarkup(<TabPanel idPrefix="admin" id="alur" active={false}><p>Isi</p></TabPanel>);
  assert.match(inactive, /role="tabpanel"/u);
  assert.match(inactive, /aria-labelledby="admin-tab-alur"/u);
  assert.match(inactive, /hidden=""/u);
  const active = renderToStaticMarkup(<TabPanel idPrefix="admin" id="alur" active><p>Isi</p></TabPanel>);
  assert.doesNotMatch(active, /hidden=""/u);
});

test("menu is closed by default and exposes menuitems only when open", () => {
  const items = [
    { id: "help", label: "Bantuan", href: "#bantuan" },
    { id: "about", label: "Tentang Waspada", onSelect: () => {} },
  ];
  const closed = renderToStaticMarkup(<Menu triggerContent="Akun" items={items} />);
  assert.match(closed, /aria-haspopup="menu"/u);
  assert.match(closed, /aria-expanded="false"/u);
  assert.doesNotMatch(closed, /role="menu"/u);
  assert.doesNotMatch(closed, /role="menuitem"/u);

  const open = renderToStaticMarkup(<Menu defaultOpen triggerContent="Akun" items={items} align="end" />);
  assert.match(open, /aria-expanded="true"/u);
  assert.match(open, /role="menu"/u);
  assert.match(open, /class="menu__list menu__list--end"/u);
  assert.equal((open.match(/role="menuitem"/gu) ?? []).length, 2);
  assert.match(open, /<a[^>]*href="#bantuan"[^>]*>Bantuan<\/a>/u);
  assert.match(open, /<button[^>]*role="menuitem"[^>]*>Tentang Waspada<\/button>/u);
});

test("popover keeps its explanation in the markup and links the trigger to the hidden panel", () => {
  const markup = renderToStaticMarkup(
    <Popover triggerClassName="site-header__badge" triggerContent="Data contoh">
      <p>Penjelasan dataset</p>
    </Popover>,
  );
  assert.match(markup, /aria-expanded="false"/u);
  assert.match(markup, /Data contoh<\/button>/u);
  assert.match(markup, /Penjelasan dataset/u);
  const controls = markup.match(/aria-controls="([^"]+)"/u)?.[1] ?? "";
  assert.notEqual(controls, "");
  assert.match(markup, new RegExp(`<div id="${controls.replace(/[.*+?^${}()|[\]\\«»]/gu, "\\$&")}" class="popover__panel" hidden="">`, "u"));
});

test("vertical tabs announce their orientation and take ArrowUp and ArrowDown through the same roving group", () => {
  const tabs = [
    { id: "ringkasan", label: "Ringkasan", icon: <span className="icon-probe" /> },
    { id: "tinjau", label: "Tinjau" },
  ];
  const markup = renderToStaticMarkup(<Tabs idPrefix="admin" label="Bagian" tabs={tabs} value="tinjau" onChange={() => {}} orientation="vertical" />);
  assert.match(markup, /role="tablist" aria-label="Bagian" aria-orientation="vertical"/u);
  assert.match(markup, /<span class="tabs__icon" aria-hidden="true"><span class="icon-probe"><\/span><\/span>Ringkasan/u, "icons are decorative and hidden from assistive tech");
  assert.equal(nextRovingIndex("ArrowDown", 0, 2, "vertical"), 1);
  assert.equal(nextRovingIndex("ArrowUp", 0, 2, "vertical"), 1, "wraps at the top");
  assert.equal(nextRovingIndex("ArrowRight", 0, 2, "vertical"), null, "horizontal keys do not move a vertical rail");
  const horizontal = renderToStaticMarkup(<Tabs idPrefix="admin" label="Bagian" tabs={tabs} value="tinjau" onChange={() => {}} />);
  assert.match(horizontal, /aria-orientation="horizontal"/u, "horizontal stays the default");
});
