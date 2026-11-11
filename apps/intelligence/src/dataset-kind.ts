// INTEL-02 B3: the standalone worker has no default dataset. An unset or unknown DATASET_KIND stops
// it before it connects, so it never writes into the wrong dataset. serve:live passes "live" itself.
import type { DatasetKind } from "../../db/src/ports.js";

export const DATASET_KINDS = ["live", "historical", "synthetic"] as const;

export class DatasetKindConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatasetKindConfigError";
  }
}

export function parseDatasetKind(raw: string | undefined): DatasetKind {
  const value = raw?.trim() ?? "";
  if (value === "") {
    throw new DatasetKindConfigError(
      `DATASET_KIND is not set. Set DATASET_KIND to one of: ${DATASET_KINDS.join(", ")}. The worker does not default to live.`,
    );
  }
  if (!(DATASET_KINDS as readonly string[]).includes(value)) {
    throw new DatasetKindConfigError(
      `DATASET_KIND "${value}" is not valid. Use one of: ${DATASET_KINDS.join(", ")}.`,
    );
  }
  return value as DatasetKind;
}
