import type { SessionEnvelope } from "@waspada/worker/account-contracts";
import { SourceApprovalPanel } from "./SourceApprovalPanel.js";
import { SourcePointMap } from "./SourcePointMap.js";
import { UnifiedSourceExplorer } from "./UnifiedSourceExplorer.js";

/**
 * Sumber tab (admin only). It is loaded lazily by the workspace, so the source map stays out of the other tabs.
 * The registry approval panel (FR-12) comes first. The demo explorer below keeps its own demo guard: nothing is
 * requested unless the dataset is demo.
 */
export default function AdminSourceTab({ datasetMode, canRequestProviderFetch = false, session }: { datasetMode: "demo" | "live" | null; canRequestProviderFetch?: boolean; session: SessionEnvelope }) {
  return (
    <>
      <SourceApprovalPanel session={session} />
      <UnifiedSourceExplorer
        datasetMode={datasetMode}
        canRequestProviderFetch={canRequestProviderFetch}
        renderMap={(points, selectedId, onSelect, onReturnToList) => (
          <SourcePointMap points={points} selectedId={selectedId} onSelect={onSelect} onReturnToList={onReturnToList} viewMode="unified" />
        )}
      />
    </>
  );
}
