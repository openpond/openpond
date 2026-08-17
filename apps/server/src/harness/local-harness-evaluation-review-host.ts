import type {
  HarnessEvaluationReviewReceipt,
  ImprovementObservation,
  RefinementTriggerDecision,
} from "@openpond/contracts";
import { contentHash } from "@openpond/harness";
import type { HarnessEvaluationReviewModelStream } from "@openpond/harness";

import type { SqliteStore } from "../store/store.js";
import { resolveSelectedLocalHarnessRelease } from "./local-harness-selection.js";
import { reviewSelectedLocalHarnessEvaluation } from "./local-harness-evaluation-review.js";

const SOURCE_POLICY_VERSION = "local-personal-work-v1";

export async function reviewSelectedLocalHarnessEvaluationFromHost(input: {
  store: SqliteStore;
  storeDir: string;
  workspaceId: string;
  maxEstimatedCostUsd: number;
  stream?: HarnessEvaluationReviewModelStream;
  signal?: AbortSignal;
  now?: () => string;
}): Promise<HarnessEvaluationReviewReceipt> {
  const selected = await resolveSelectedLocalHarnessRelease(input.store);
  if (!selected || selected.workspaceId !== input.workspaceId) {
    throw new Error("Evaluation review requires the selected Personal Local Harness.");
  }
  const workspace = await input.store.getHarnessWorkspace(input.workspaceId);
  if (!workspace || workspace.ownerScope.kind !== "personal" || workspace.location !== "local") {
    throw new Error("Evaluation review requires the selected Personal Local Harness.");
  }
  const [observations, triggers] = await Promise.all([
    input.store.listHarnessImprovementArtifacts(input.workspaceId, "observation", 10_000),
    input.store.listHarnessImprovementArtifacts(input.workspaceId, "trigger_decision", 10_000),
  ]);
  const sourceRefs = new Set([
    ...(observations as ImprovementObservation[]).map((observation) => observation.runRef),
    ...(triggers as RefinementTriggerDecision[]).map((trigger) => trigger.runRef),
  ]);
  const checkedAt = (input.now ?? (() => new Date().toISOString()))();
  const sourcePolicies = await Promise.all([...sourceRefs].sort().map(async (sourceRef) => {
    const session = await input.store.getSession(sourceRef);
    return {
      sourceRef,
      policy: {
        id: `source-policy-${contentHash({
          workspaceId: input.workspaceId,
          sourceRef,
          policyVersion: SOURCE_POLICY_VERSION,
        }).slice(0, 24)}`,
        contentHash: contentHash({
          workspaceId: input.workspaceId,
          sourceRef,
          policyVersion: SOURCE_POLICY_VERSION,
        }),
      },
      state: session ? "authorized" as const : "deleted" as const,
      checkedAt,
    };
  }));
  return reviewSelectedLocalHarnessEvaluation({
    store: input.store,
    request: {
      sourcePolicies,
      limits: {
        maxEvidence: 200,
        maxTokens: 50_000,
        maxDurationMs: 240_000,
        maxEstimatedCostUsd: input.maxEstimatedCostUsd,
      },
    },
    stream: input.stream,
    signal: input.signal,
    now: input.now,
    continuation: input.stream ? {
      storeDir: input.storeDir,
      stream: input.stream,
    } : undefined,
  });
}
