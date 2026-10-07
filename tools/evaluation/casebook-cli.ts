/**
 * Bounded local-file CLI for the EVAL-01 casebook metadata contract.
 *
 * This command reports only structural validation and declared readiness. It
 * does not access source content, rights records, reviewers, providers, or a
 * network service.
 */

import { open, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";
import {
  evaluateReleaseReadiness,
  validateCasebook,
  type CasebookIssueCode,
  type ReadinessReasonCode,
} from "./casebook.js";

export const MAX_CASEBOOK_BYTES = 5 * 1024 * 1024;

export interface CasebookCliResult {
  readonly valid: boolean;
  readonly metadata_ready: boolean;
  readonly issue_codes: readonly CasebookIssueCode[];
  readonly readiness_reasons: readonly ReadinessReasonCode[];
}

type CliErrorCode = "USAGE" | "READ_ERROR" | "FILE_TOO_LARGE" | "INVALID_UTF8" | "INVALID_JSON" | "INTERNAL_ERROR";
type FileReadResult = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly errorCode: CliErrorCode };

function writeError(errorCode: CliErrorCode): void {
  process.stderr.write(`${JSON.stringify({ error_code: errorCode })}\n`);
}

async function readBoundedFile(path: string): Promise<FileReadResult> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const pathInfo = await stat(path);
    if (!pathInfo.isFile()) return { ok: false, errorCode: "READ_ERROR" };
    if (pathInfo.size > MAX_CASEBOOK_BYTES) return { ok: false, errorCode: "FILE_TOO_LARGE" };

    handle = await open(path, "r");
    const openedInfo = await handle.stat();
    if (!openedInfo.isFile()) return { ok: false, errorCode: "READ_ERROR" };
    if (openedInfo.size > MAX_CASEBOOK_BYTES) return { ok: false, errorCode: "FILE_TOO_LARGE" };

    // One byte beyond the limit detects a file that grows after stat without
    // ever reading an unbounded amount into memory.
    const buffer = Buffer.allocUnsafe(MAX_CASEBOOK_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > MAX_CASEBOOK_BYTES) return { ok: false, errorCode: "FILE_TOO_LARGE" };

    try {
      return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, total)) };
    } catch {
      return { ok: false, errorCode: "INVALID_UTF8" };
    }
  } catch {
    return { ok: false, errorCode: "READ_ERROR" };
  } finally {
    try {
      await handle?.close();
    } catch {
      // A close failure must not reveal local paths or platform error details.
    }
  }
}

/** Map the closed result state to the documented process exit status. */
export function exitCodeFor(valid: boolean, metadataReady: boolean): 0 | 1 | 2 {
  if (!valid) return 2;
  return metadataReady ? 0 : 1;
}

/** Run the CLI against one local path and write its closed result to stdout. */
export async function runCasebookCli(args: readonly string[]): Promise<0 | 1 | 2> {
  if (args.length !== 1 || args[0].length === 0) {
    writeError("USAGE");
    return 2;
  }

  const file = await readBoundedFile(args[0]);
  if (!file.ok) {
    writeError(file.errorCode);
    return 2;
  }

  let input: unknown;
  try {
    input = JSON.parse(file.text) as unknown;
  } catch {
    writeError("INVALID_JSON");
    return 2;
  }

  const validation = validateCasebook(input);
  const readiness = evaluateReleaseReadiness(input);
  const result: CasebookCliResult = {
    valid: validation.valid,
    metadata_ready: validation.valid && readiness.ready,
    issue_codes: [...new Set(validation.issues.map((issue) => issue.code))],
    readiness_reasons: readiness.reasonCodes,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return exitCodeFor(result.valid, result.metadata_ready);
}

function isDirectExecution(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && resolve(entrypoint) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  void runCasebookCli(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch(() => {
      writeError("INTERNAL_ERROR");
      process.exitCode = 2;
    });
}