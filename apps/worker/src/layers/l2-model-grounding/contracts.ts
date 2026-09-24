import type { EventView } from "../../contracts/public-api.js";

export interface ModelCapabilityAdapter {
  extract(input: string): Promise<unknown>;
  embed(input: string): Promise<readonly number[]>;
  reason(input: string): Promise<unknown>;
}

export interface GroundingService {
  retrieve(query: string): Promise<readonly EventView[]>;
  assessClaimSupport(claim: string): Promise<"supported" | "uncertain" | "disputed">;
}

// Interfaces only: BOOT-01 does not configure a model provider or retrieval store.
