import type { executeJavaScriptVerifier } from "../javascript-verifier.js";
import { verifyLearningTextAsset } from "./assets.js";
import { executeRewardFixture, type RewardCheckRuntime } from "./reward-checks.js";
import type { RewardFixtureExecutor } from "./reward-check-worker.js";

/** The supplied interpreter must settle only after its worker/process exits. */
export function createIsolatedRewardFixtureExecutor(options: {
  runtime: RewardCheckRuntime;
  executeJavaScript: typeof executeJavaScriptVerifier;
}): RewardFixtureExecutor {
  return {
    runtime: options.runtime,
    execute(input) {
      return executeRewardFixture({
        reward: input.reward, fixture: input.fixture, signal: input.signal,
        customVerifier: async ({ grader, task, evidence }) => {
          const asset = input.assets.find(asset => asset.id === grader.verifierRef.id);
          if (!asset) throw new Error("reward_check_source_missing");
          const source = verifyLearningTextAsset(asset, grader.verifierRef);
          const result = await options.executeJavaScript({
            source, exportName: grader.exportName, signal: input.signal,
            timeoutMs: Math.min(grader.timeoutMs, input.run.timeoutMs),
            value: { task, attempt: evidence, input: task.input, output: evidence.output, expectedOutput: task.expectedOutput,
              evaluatorContext: input.fixture.evaluatorContext, infrastructureError: evidence.infrastructureError ?? null },
          });
          return { score: result.score, passed: result.passed, rewardEligible: grader.rewardEligible, failureClass: null,
            feedback: [result.feedback], visibleEvidenceRefs: [], privilegedEvidenceRefs: result.evidenceRefs };
        },
      });
    },
    // No remote allocation; executeJavaScript's settlement contract confirms cleanup.
    async cancel() { return true; },
  };
}
