import { createHash, randomUUID } from "node:crypto";
import {
  HarnessImprovementProposalSchema,
  HarnessRefinerOutcomeSchema,
  HarnessTargetedValidationReceiptSchema,
  ImprovementApplyReceiptSchema,
  ImprovementRouteDecisionSchema,
  RefinementTriggerDecisionSchema,
  type HarnessImprovementProposal,
  type HarnessRefinerOutcome,
  type HarnessTargetedValidationReceipt,
  type ImprovementApplyReceipt,
  type ImprovementRouteDecision,
  type RefinementTriggerDecision,
} from "@openpond/contracts";
import { HOST_STORAGE_CONTRACT_VERSION, type AgentHostStorageClient } from "@openpond/agent-runtime";
import { z } from "zod";

type Kind = "trigger_decision" | "route_decision" | "refiner_outcome"
  | "proposal" | "targeted_validation" | "apply_receipt";
type ArtifactByKind = {
  trigger_decision: RefinementTriggerDecision;
  route_decision: ImprovementRouteDecision;
  refiner_outcome: HarnessRefinerOutcome;
  proposal: HarnessImprovementProposal;
  targeted_validation: HarnessTargetedValidationReceipt;
  apply_receipt: ImprovementApplyReceipt;
};
const schemas = {
  trigger_decision: RefinementTriggerDecisionSchema,
  route_decision: ImprovementRouteDecisionSchema,
  refiner_outcome: HarnessRefinerOutcomeSchema,
  proposal: HarnessImprovementProposalSchema,
  targeted_validation: HarnessTargetedValidationReceiptSchema,
  apply_receipt: ImprovementApplyReceiptSchema,
};
const cursorSchema = z.object({ createdAt: z.string().min(1), id: z.string().min(1) }).strict();
const pageSchema = z.object({ entries: z.array(z.unknown()).max(200), nextBefore: cursorSchema.nullable() }).strict();

/** Scoped Refiner artifacts. Reconciliation must be invoked for an admitted
 * workspace; a child cannot enumerate another owner's pending triggers. */
export class HostedRefinerStorage {
  constructor(private readonly client: AgentHostStorageClient) {}

  async saveHarnessImprovementArtifact<K extends Kind>(
    workspaceId: string, kind: K, input: ArtifactByKind[K],
  ): Promise<ArtifactByKind[K]> {
    const artifact = schemas[kind].parse(input) as ArtifactByKind[K];
    const requestId = `refiner:${createHash("sha256").update(JSON.stringify({ workspaceId, kind, artifact })).digest("hex")}`;
    const result = await this.client.request({
      contractVersion: HOST_STORAGE_CONTRACT_VERSION, requestId,
      operation: "refiner/execute", params: { action: { action: "put_artifact", workspaceId, kind, artifact } },
    });
    return schemas[kind].parse(z.object({ artifact: z.unknown() }).strict().parse(result).artifact) as ArtifactByKind[K];
  }

  async listHarnessImprovementArtifacts<K extends Kind>(
    workspaceId: string, kind: K, limit = 100,
  ): Promise<ArtifactByKind[K][]> {
    const maximum = Math.max(1, Math.min(1_000, Math.trunc(limit)));
    const entries: ArtifactByKind[K][] = [];
    let before: z.infer<typeof cursorSchema> | null = null;
    while (entries.length < maximum) {
      const page = pageSchema.parse(await this.client.request({
        contractVersion: HOST_STORAGE_CONTRACT_VERSION, requestId: randomUUID(),
        operation: "refiner/execute", params: { action: { action: "artifact_page", workspaceId, kind,
          before, limit: Math.min(200, maximum - entries.length) } },
      }));
      entries.push(...page.entries.map((value) => schemas[kind].parse(value) as ArtifactByKind[K]));
      if (page.nextBefore === null) break;
      assertCursorAdvanced(before, page.nextBefore, page.entries.length, "desc");
      before = page.nextBefore;
    }
    return entries;
  }

  async listPendingHarnessRefinerTriggersForWorkspace(workspaceId: string, limit = 1_000): Promise<Array<{
    workspaceId: string; trigger: RefinementTriggerDecision;
  }>> {
    const maximum = Math.max(1, Math.min(1_000, Math.trunc(limit)));
    const entries: Array<{ workspaceId: string; trigger: RefinementTriggerDecision }> = [];
    let before: z.infer<typeof cursorSchema> | null = null;
    while (entries.length < maximum) {
      const page = pageSchema.parse(await this.client.request({
        contractVersion: HOST_STORAGE_CONTRACT_VERSION, requestId: randomUUID(),
        operation: "refiner/execute", params: { action: { action: "pending_trigger_page", workspaceId,
          before, limit: Math.min(200, maximum - entries.length) } },
      }));
      entries.push(...page.entries.map((value) => {
        const trigger = RefinementTriggerDecisionSchema.parse(value);
        if (trigger.decision !== "queue_refiner") throw new Error("Host returned a non-pending Refiner trigger.");
        return { workspaceId, trigger };
      }));
      if (page.nextBefore === null) break;
      assertCursorAdvanced(before, page.nextBefore, page.entries.length, "asc");
      before = page.nextBefore;
    }
    return entries;
  }
}

function assertCursorAdvanced(
  before: z.infer<typeof cursorSchema> | null,
  next: z.infer<typeof cursorSchema>,
  count: number,
  direction: "asc" | "desc",
): void {
  const comparison = before && (next.createdAt.localeCompare(before.createdAt)
    || next.id.localeCompare(before.id));
  if (count === 0 || (comparison !== null && comparison !== undefined &&
    (direction === "asc" ? comparison <= 0 : comparison >= 0))) {
    throw new Error("Host Refiner cursor did not advance.");
  }
}
