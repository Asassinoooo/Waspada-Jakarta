import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountAccessGate } from "../src/AccountPages.js";
import type { SessionEnvelope } from "@waspada/worker/account-contracts";
import { nodeView, PIPELINE_FLOW_NODE_TYPE } from "../src/pipeline-flow-model.js";
import { NineRouterMeters, PipelineDrawer, PipelineHeaderStrip, PipelineLegend, remainingCooldownMs } from "../src/PipelineFlow.js";
import { demoSnapshot } from "./pipeline-flow-fixtures.js";

const noop = () => {};

const anonymousSession: SessionEnvelope = {
  version: "account-v1",
  status: "anonymous",
  password_login_available: true,
  registration_available: true,
  csrf_token: null,
  user: null,
};

test("the header strip labels demo and live data differently and shows pause, with no layout controls because the diagram is fixed", () => {
  const demo = renderToStaticMarkup(
    <PipelineHeaderStrip mode="demo" generatedAt="2026-11-11T09:00:00.000Z" paused={false} loadState="ready" runtimeAvailable onTogglePause={noop} onRefresh={noop} />,
  );
  assert.match(demo, /Data contoh/u);
  assert.match(demo, /Jeda pembaruan/u);
  assert.doesNotMatch(demo, /Atur ulang tata letak/u);

  const live = renderToStaticMarkup(
    <PipelineHeaderStrip mode="live" generatedAt={null} paused loadState="ready" runtimeAvailable={false} onTogglePause={noop} onRefresh={noop} />,
  );
  assert.match(live, /Langsung/u);
  assert.match(live, /Lanjutkan pembaruan/u);
  assert.match(live, /Status runtime tidak tersedia/u, "a null runtime is said plainly");
  assert.doesNotMatch(live, /Data contoh/u);
});

test("the drawer explains the stage, lists counts and says when there are no recent items", () => {
  const snapshot = demoSnapshot();
  const queue = snapshot.nodes.find((node) => node.id === "ai_queue")!;
  const empty = renderToStaticMarkup(
    <PipelineDrawer view={nodeView(queue)} nineRouter={null} generatedAt={null} items={null} itemState="loading" onClose={noop} />,
  );
  assert.match(empty, /role="dialog"/u);
  assert.match(empty, /Antrean AI/u);
  assert.match(empty, /Memuat rincian/u);
  assert.match(empty, /Menunggu/u);

  const none = renderToStaticMarkup(
    <PipelineDrawer
      view={nodeView(snapshot.nodes.find((node) => node.id === "src_bmkg")!)}
      nineRouter={null}
      generatedAt={null}
      items={{ schema_version: "pipeline-flow-v1", generated_at: "2026-11-11T09:00:00.000Z", dataset_mode: "demo", node_id: "src_bmkg", limit: 20, items: [], unavailable_reason: null }}
      itemState="ready"
      onClose={noop}
    />,
  );
  assert.match(none, /Tidak ada rincian dalam 24 jam\./u);

  const reviewed = renderToStaticMarkup(
    <PipelineDrawer
      view={nodeView(snapshot.nodes.find((node) => node.id === "proposal")!)}
      nineRouter={null}
      generatedAt={null}
      items={{
        schema_version: "pipeline-flow-v1", generated_at: "2026-11-11T09:00:00.000Z", dataset_mode: "demo", node_id: "proposal", limit: 20,
        items: [{ ref: "prop-demo-001", status: "menunggu", failure_code: null, title: "Contoh fiktif: genangan dekat Tebet", at: "2026-11-11T08:55:00.000Z" }],
        unavailable_reason: null,
      }}
      itemState="ready"
      onClose={noop}
    />,
  );
  assert.match(reviewed, /prop-demo-001/u);
  assert.match(reviewed, /Contoh fiktif: genangan dekat Tebet/u);
  assert.match(reviewed, /href="#admin\/tinjau"/u, "proposals link to the review tab of the admin workspace");
});

test("the NineRouter meters show RPM use and a cooldown, and the layer legend is in Indonesian", () => {
  const runtime = demoSnapshot().runtime!.ninerouter;
  const markup = renderToStaticMarkup(<NineRouterMeters runtime={runtime} generatedAt="2026-11-11T09:00:00.000Z" />);
  assert.match(markup, /role="meter"/u);
  assert.match(markup, /6 dari 10 \/ menit/u);
  assert.match(markup, /Masa tunggu: /u, "the cooldown row is always present");
  assert.match(markup, /Panggilan sejak start: 1\.522|Panggilan sejak start: 1522/u);

  const legend = renderToStaticMarkup(<PipelineLegend />);
  for (const name of ["Penerimaan laporan", "Pencarian bukti", "Pemeriksaan lanjutan", "Tinjauan laporan", "Pemantauan sistem"]) {
    assert.match(legend, new RegExp(name, "u"));
  }
});

test("the cooldown counts down from the snapshot clock and never goes negative", () => {
  assert.equal(remainingCooldownMs(42_000, "2026-11-11T09:00:00.000Z", Date.parse("2026-11-11T09:00:10.000Z")), 32_000);
  assert.equal(remainingCooldownMs(42_000, "2026-11-11T09:00:00.000Z", Date.parse("2026-11-11T09:01:00.000Z")), 0);
  assert.equal(remainingCooldownMs(0, null, 0), 0);
  assert.equal(PIPELINE_FLOW_NODE_TYPE, "flow");
});

test("the review access gate refuses anonymous and non-moderator sessions with Indonesian copy", () => {
  const anonymous = renderToStaticMarkup(
    <AccountAccessGate shell="review" sessionState={{ status: "anonymous", session: anonymousSession }} isNarrowScreen={false} onRefreshSession={noop} />,
  );
  assert.match(anonymous, /Sesi diperlukan/u);
  assert.match(anonymous, /akun moderator atau administrator/u);
});
