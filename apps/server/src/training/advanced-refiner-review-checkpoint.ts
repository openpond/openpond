import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { contentHash } from "@openpond/harness";
import {
  RefinementTriggerDecisionSchema,
  HarnessRefinerOutcomeSchema,
  HarnessImprovementProposalSchema,
  HarnessTargetedValidationReceiptSchema,
  HarnessRunOverlaySchema,
  HarnessWorkspaceSchema,
  HarnessAdvanceReceiptSchema,
  ImprovementApplyReceiptSchema,
} from "@openpond/contracts";
import {
  AdvancedRefinerReviewCaseReceiptSchema,
  type AdvancedRefinerEvaluationPin,
} from "openpond-sdk/advanced-refiner-evaluations";
const Result = z.object({
  outcome: HarnessRefinerOutcomeSchema,
  proposal: HarnessImprovementProposalSchema.nullable(),
  validations: z.array(HarnessTargetedValidationReceiptSchema),
  overlay: HarnessRunOverlaySchema,
  workspace: HarnessWorkspaceSchema,
  advanceReceipt: HarnessAdvanceReceiptSchema.nullable(),
  applyReceipt: ImprovementApplyReceiptSchema.nullable(),
});
const Checkpoint = z.object({
  runId: z.string(),
  taskId: z.string(),
  actorId: z.string(),
  teamId: z.string(),
  pinHash: z.string(),
  sourceCaseHash: z.string(),
  sessionId: z.string(),
  turnId: z.string(),
  workspaceId: z.string(),
  trigger: RefinementTriggerDecisionSchema,
  result: Result.nullable(),
  receipt: AdvancedRefinerReviewCaseReceiptSchema.nullable(),
  cleanupComplete: z.boolean(),
  contentHash: z.string(),
});
export type ReviewCheckpoint = z.infer<typeof Checkpoint>;
/** Retains actual case context and worker output before grading/cleanup. Restart
 * cannot manufacture another paid trigger for an interrupted case. */
export function createAdvancedReviewCheckpoints(storeDir: string) {
  const file = (runId: string, taskId: string) =>
    path.join(
      storeDir,
      "training",
      "advanced-refiner-reviews",
      contentHash([runId, taskId]) + ".json",
    );
  async function read(
    runId: string,
    taskId: string,
    pin: AdvancedRefinerEvaluationPin,
  ) {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(file(runId, taskId), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const value = Checkpoint.parse(raw),
      { contentHash: hash, ...body } = value;
    if (
      hash !== contentHash(body) ||
      value.runId !== runId ||
      value.taskId !== taskId ||
      value.actorId !== pin.actorId ||
      value.teamId !== pin.teamId ||
      value.pinHash !== pin.contentHash
    )
      throw new Error(
        "The retained review case belongs to another immutable admission.",
      );
    return value;
  }
  async function write(raw: Omit<ReviewCheckpoint, "contentHash">) {
    const value = Checkpoint.parse({ ...raw, contentHash: contentHash(raw) }),
      destination = file(value.runId, value.taskId),
      temporary = destination + "." + randomUUID();
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, destination);
    return value;
  }
  return { read, write };
}
