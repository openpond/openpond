import { contentHash } from "@openpond/harness";
import type { Turn } from "@openpond/contracts";
import { createNativeHarnessExperimentAttempt, type StandaloneHarnessExperimentSource } from "@openpond/evals/experiments";
import type { ExperimentModelCase } from "../evaluations/experiment-case-contract.js";

/** Native events remain in the authorized turn store. This owner receipt
 * retains exact references and bounded policy evidence for private grading;
 * it does not duplicate raw provider diagnostics or private runtime payloads. */
export function sealStandaloneExperimentReceipt(input: {
  request: ExperimentModelCase;
  source: StandaloneHarnessExperimentSource;
  turn: Turn;
  output: string;
  traceHash: string;
  runtimeEventRefs: string[];
  cancelled: boolean;
  timedOut: boolean;
  maxOutputBytes: number;
}) {
  if (!input.turn.completedAt) throw new Error("Native Experiment receipt requires a settled turn.");
  const exceeded = Buffer.byteLength(input.output, "utf8") > input.maxOutputBytes;
  const status = input.cancelled ? "cancelled" : input.timedOut ? "timed_out"
    : input.turn.status === "interrupted" ? "cancelled"
    : input.turn.status === "completed" && !exceeded ? "completed" : "policy_failure";
  const error = status === "completed" ? null : exceeded
    ? "Native Harness output exceeded its admitted byte limit."
    : status === "timed_out" ? "Native Harness case timed out."
    : status === "cancelled" ? "Native Harness case was cancelled."
    : "Native Harness case failed; inspect its retained turn evidence.";
  const content: Parameters<typeof createNativeHarnessExperimentAttempt>[0] = {
    schemaVersion: "openpond.nativeHarnessExperimentAttempt.v1" as const,
    taskId: input.request.taskId, status,
    output: status === "completed" ? input.output : null,
    error,
    messages: [
      { role: "user" as const, text: JSON.stringify({ instructions: input.request.instructions,
        input: input.request.input, policyVisibleContext: input.request.policyVisibleContext }) },
      ...(status === "completed" ? [{ role: "assistant" as const, text: input.output, toolCalls: [] }] : []),
    ],
    collected: status === "completed",
    environmentCleanupComplete: true,
    snapshot: null,
    native: {
      sessionId: input.turn.sessionId, turnId: input.turn.id,
      source: input.source, admissionHash: input.request.admissionHash,
      modelConfigurationHash: input.request.model.configurationHash,
      traceHash: input.traceHash, runtimeEventRefs: input.runtimeEventRefs,
      startedAt: input.turn.startedAt, completedAt: input.turn.completedAt,
      outputHash: contentHash(input.output),
      partialOutputAvailable: status !== "completed" && input.output.length > 0,
    },
  };
  return createNativeHarnessExperimentAttempt(content);
}
