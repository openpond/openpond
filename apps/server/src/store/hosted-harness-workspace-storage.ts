import { createHash } from "node:crypto";
import {
  advanceHarnessWorkspace, advanceReviewedHarnessWorkspace,
  HarnessAdvanceReceiptSchema, HarnessWorkspaceSchema,
  rollbackHarnessWorkspace,
} from "@openpond/contracts";
import {
  HOST_STORAGE_CONTRACT_VERSION,
  type AgentHostStorageClient, type HostStorageRequest,
} from "@openpond/agent-runtime";
import { z } from "zod";

type TransitionParams = Extract<HostStorageRequest, { operation: "harness/workspace/transition" }>["params"];
type AdvanceInput = Omit<Parameters<typeof advanceHarnessWorkspace>[0], "workspace"> & { workspaceId: string };
type ReviewedAdvanceInput = Omit<Parameters<typeof advanceReviewedHarnessWorkspace>[0], "workspace"> & { workspaceId: string };
type RollbackInput = Omit<Parameters<typeof rollbackHarnessWorkspace>[0], "workspace"> & { workspaceId: string };

const resultSchema = z.object({
  workspace: HarnessWorkspaceSchema,
  receipt: HarnessAdvanceReceiptSchema,
}).strict();

/** Typed child adapter; the host applies authenticated scope and release admission. */
export class HostedHarnessWorkspaceStorage {
  constructor(private readonly client: AgentHostStorageClient) {}

  private async transition(params: TransitionParams) {
    const requestId = `harness-transition:${createHash("sha256").update(params.receiptId).digest("hex")}`;
    return resultSchema.parse(await this.client.request({
      contractVersion: HOST_STORAGE_CONTRACT_VERSION,
      requestId,
      operation: "harness/workspace/transition",
      params,
    }));
  }

  async advanceHarnessWorkspaceAtomically(input: AdvanceInput) {
    return this.transition({ action: "advance", ...input });
  }

  async advanceReviewedHarnessWorkspaceAtomically(input: ReviewedAdvanceInput) {
    return this.transition({ action: "reviewedAdvance", ...input });
  }

  async rollbackHarnessWorkspaceAtomically(input: RollbackInput) {
    return this.transition({ action: "rollback", ...input });
  }
}
