import { SourcePointMap } from "./SourcePointMap.js";
import { UnifiedSourceExplorer } from "./UnifiedSourceExplorer.js";

/**
 * Demo sumber tab (admin only). It is loaded lazily by the workspace, so the source map stays out of the
 * other tabs. The explorer keeps its own demo guard: nothing is requested unless the dataset is demo.
 */
export default function AdminSourceTab({ datasetMode, canRequestProviderFetch = false }: { datasetMode: "demo" | "live" | null; canRequestProviderFetch?: boolean }) {
  return (
    <UnifiedSourceExplorer
      datasetMode={datasetMode}
      canRequestProviderFetch={canRequestProviderFetch}
      renderMap={(points, selectedId, onSelect, onReturnToList) => (
        <SourcePointMap points={points} selectedId={selectedId} onSelect={onSelect} onReturnToList={onReturnToList} viewMode="unified" />
      )}
    />
  );
}
