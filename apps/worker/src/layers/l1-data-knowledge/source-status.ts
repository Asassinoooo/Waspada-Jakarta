import type { PublicContext } from "../../contracts/public-api.js";

export interface SourceStatusProvider {
  listPublicSourceStatus(): PublicContext["sources"];
}

// BOOT-01 has no real source connectors. An empty registry is honest coverage,
// not an all-clear signal.
export const noConfiguredSources: SourceStatusProvider = {
  listPublicSourceStatus: () => [],
};
