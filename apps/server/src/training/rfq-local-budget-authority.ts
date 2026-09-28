import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import type { RfqLocalBudgetAuthority } from "./rfq-local-model-admission.js";

const execFileAsync = promisify(execFile);

/** Explicit local-only bridge to the private RFQ SQLite transaction ledger.
 * Do not select this in hosted workers: the database must be one shared local
 * file for every reservation in the experiment. */
export function createRfqLocalSqliteBudgetAuthority(input: {
  pythonExecutable: string;
  ledgerScriptPath: string;
  databasePath: string;
}): RfqLocalBudgetAuthority {
  if (!input.pythonExecutable.trim() || !path.isAbsolute(input.ledgerScriptPath)
    || !path.isAbsolute(input.databasePath)) {
    throw new Error("RFQ local ledger requires an executable and absolute script/database paths.");
  }
  async function invoke(args: string[]): Promise<void> {
    await execFileAsync(input.pythonExecutable,
      [input.ledgerScriptPath, "--db", input.databasePath, ...args],
      { timeout: 35_000, maxBuffer: 64 * 1024 });
  }
  return {
    async reserve({ allocationId, requestHash, maximumCents }) {
      if (!Number.isSafeInteger(maximumCents) || maximumCents <= 0) {
        throw new Error("RFQ reservation must have a positive cent maximum.");
      }
      await invoke(["reserve", allocationId, "model", requestHash,
        "--max-usd", (maximumCents / 100).toFixed(2)]);
    },
    async markDispatched(allocationId) { await invoke(["dispatch", allocationId]); },
    async releaseBeforeDispatch(allocationId) { await invoke(["release", allocationId]); },
  };
}
