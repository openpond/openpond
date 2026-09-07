import { createRequire } from "node:module";
import { createIsolatedRewardFixtureExecutor } from "@openpond/evals/learning";
import { executeJavaScriptVerifierInWorker } from "@openpond/evals/javascript-verifier/node";

export function createLocalRewardCheckExecutor() {
  const metadata = createRequire(import.meta.url)("@openpond/evals/package.json") as { version: string };
  return createIsolatedRewardFixtureExecutor({
    runtime: { id: "openpond.reward-fixtures.node-worker.v1", packageVersion: metadata.version, engine: `Node ${process.versions.node}` },
    executeJavaScript: executeJavaScriptVerifierInWorker,
  });
}
