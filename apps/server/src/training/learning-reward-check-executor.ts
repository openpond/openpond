import metadata from "@openpond/evals/package.json" with { type: "json" };
import { createBudgetedRewardFixtureExecutor, type BoundJudgeProvider, type LearningRepository } from "@openpond/evals/learning";
import { executeJavaScriptVerifierInWorker } from "@openpond/evals/javascript-verifier/node";
import { createLearningHostedJudgeProvider } from "./learning-hosted-judge-provider.js";

export function createLocalRewardCheckExecutor(repository: LearningRepository, provider: BoundJudgeProvider = createLearningHostedJudgeProvider()) {
  return createBudgetedRewardFixtureExecutor({
    repository, provider,
    runtime: { id: "openpond.reward-fixtures.node-worker.v1", packageVersion: metadata.version, engine: `Node ${process.versions.node}` },
    executeJavaScript: executeJavaScriptVerifierInWorker,
  });
}
