import metadata from "@openpond/evals/package.json" with { type: "json" };
import { createIsolatedRewardFixtureExecutor } from "@openpond/evals/learning";
import { executeJavaScriptVerifierInWorker } from "@openpond/evals/javascript-verifier/node";

export function createLocalRewardCheckExecutor() {
  return createIsolatedRewardFixtureExecutor({
    runtime: { id: "openpond.reward-fixtures.node-worker.v1", packageVersion: metadata.version, engine: `Node ${process.versions.node}` },
    executeJavaScript: executeJavaScriptVerifierInWorker,
  });
}
