import { randomUUID } from "node:crypto";

import { HOST_STORAGE_CONTRACT_VERSION, type AgentHostStorageClient } from "@openpond/agent-runtime";
import {
  HarnessRunOverlaySchema, createHarnessRunOverlay,
  HarnessImprovementProposalSchema,
  type HarnessRunOverlay, type HarnessImprovementProposal,
} from "@openpond/harness";
import { z } from "zod";
import { contentHash } from "@openpond/harness";
import type { HarnessWorkspace } from "@openpond/contracts";
import type { ImmutableReleaseRef } from "@openpond/harness";

const versionedOverlaySchema = z.object({
  revision: z.number().int().nonnegative(),
  overlay: HarnessRunOverlaySchema,
}).strict();
const frozenProposalSchema = versionedOverlaySchema.extend({
  proposal: HarnessImprovementProposalSchema,
}).strict();

/** Compare-and-set port for the active run overlay in the hosted workspace. */
export class HostedHarnessOverlayStorage {
  constructor(private readonly client: AgentHostStorageClient) {}

  async getHarnessRunOverlay(runId: string): Promise<HarnessRunOverlay | null> {
    const result = await this.client.request({
      contractVersion: HOST_STORAGE_CONTRACT_VERSION,
      requestId: randomUUID(),
      operation: "harness/overlay/get",
      params: { runId },
    });
    return result === null ? null : versionedOverlaySchema.parse(result).overlay;
  }

  async putHarnessRunOverlay(input: {
    overlay: HarnessRunOverlay;
    expectedRevision: number | null;
    requestId: string;
  }): Promise<HarnessRunOverlay> {
    const overlay = HarnessRunOverlaySchema.parse(input.overlay);
    if (!input.requestId.trim() ||
        overlay.revision !== (input.expectedRevision === null ? 0 : input.expectedRevision + 1)) {
      throw new Error("Hosted Harness overlay mutation requires a stable request and next revision.");
    }
    const result = versionedOverlaySchema.parse(await this.client.request({
      contractVersion: HOST_STORAGE_CONTRACT_VERSION,
      requestId: input.requestId,
      operation: "harness/overlay/put",
      params: { runId: overlay.runId, expectedRevision: input.expectedRevision, overlay },
    }));
    if (result.revision !== overlay.revision || result.overlay.contentHash !== overlay.contentHash) {
      throw new Error("Host Harness overlay response changed committed identity.");
    }
    return result.overlay;
  }

  async createHarnessRunOverlay(overlay: HarnessRunOverlay): Promise<HarnessRunOverlay> {
    if (overlay.revision !== 0 || overlay.status !== "active") {
      throw new Error("A new Harness run overlay must be active at revision 0.");
    }
    return this.putHarnessRunOverlay({
      overlay, expectedRevision: null, requestId: `harness-overlay:${overlay.runId}:${overlay.contentHash}`,
    });
  }

  async ensureHarnessRunOverlay(input: {
    runId: string; workspace: HarnessWorkspace; harnessRelease: ImmutableReleaseRef; admittedAt: string;
  }): Promise<HarnessRunOverlay> {
    const existing = await this.getHarnessRunOverlay(input.runId);
    if (existing) {
      if (existing.workspace.workspaceId !== input.workspace.id ||
          existing.baseHarnessRelease.id !== input.harnessRelease.id ||
          existing.baseHarnessRelease.contentHash !== input.harnessRelease.contentHash) {
        throw new Error("The durable Agent run is already bound to another Harness release.");
      }
      return existing;
    }
    const overlay = createHarnessRunOverlay({
      schemaVersion: "openpond.harnessRunOverlay.v1",
      id: `overlay-${contentHash({ runId: input.runId, harnessRelease: input.harnessRelease }).slice(0, 24)}`,
      runId: input.runId, baseHarnessRelease: input.harnessRelease,
      workspace: { workspaceId: input.workspace.id, revision: input.workspace.revision,
        sourceRevision: input.workspace.sourceRevision, channelRevision: input.workspace.currentChannel.revision },
      revision: 0, status: "active", edits: [], createdAt: input.admittedAt, updatedAt: input.admittedAt, metadata: {},
    });
    return this.createHarnessRunOverlay(overlay);
  }

  async appendHarnessRunOverlayEditsAtomically(input: {
    runId: string;
    expectedRevision: number;
    edits: HarnessRunOverlay["edits"];
    updatedAt: string;
  }): Promise<HarnessRunOverlay> {
    return this.transition(input, "append");
  }

  async freezeHarnessRunOverlayAtomically(input: {
    runId: string;
    expectedRevision: number;
    updatedAt: string;
  }): Promise<HarnessRunOverlay> {
    return this.transition({ ...input, edits: [] }, "freeze");
  }

  async abandonHarnessRunOverlayAtomically(input: {
    runId: string;
    expectedRevision: number;
    updatedAt: string;
  }): Promise<HarnessRunOverlay> {
    return this.transition({ ...input, edits: [] }, "abandon");
  }

  async freezeHarnessRunOverlayWithProposalAtomically(input: {
    runId: string;
    expectedRevision: number;
    edits: HarnessRunOverlay["edits"];
    updatedAt: string;
    buildProposal: (frozenOverlay: HarnessRunOverlay) => HarnessImprovementProposal;
  }): Promise<{ overlay: HarnessRunOverlay; proposal: HarnessImprovementProposal }> {
    const current = await this.getHarnessRunOverlay(input.runId);
    if (!current || current.revision !== input.expectedRevision || current.status !== "active") {
      throw new Error("Hosted Harness overlay revision or status changed.");
    }
    const ids = new Set(current.edits.map((edit) => edit.id));
    for (const edit of input.edits) {
      if (ids.has(edit.id)) throw new Error(`Harness overlay edit id already exists: ${edit.id}.`);
      ids.add(edit.id);
    }
    const { contentHash: _hash, ...content } = current;
    const overlay = createHarnessRunOverlay({
      ...content, revision: current.revision + 1, status: "frozen",
      edits: [...current.edits, ...input.edits], updatedAt: input.updatedAt,
    });
    const proposal = HarnessImprovementProposalSchema.parse(input.buildProposal(overlay));
    const result = frozenProposalSchema.parse(await this.client.request({
      contractVersion: HOST_STORAGE_CONTRACT_VERSION,
      requestId: `harness-proposal:${overlay.runId}:${proposal.contentHash}`,
      operation: "harness/overlay/freezeProposal",
      params: { runId: overlay.runId, expectedRevision: current.revision, overlay, proposal },
    }));
    if (result.overlay.contentHash !== overlay.contentHash ||
        result.proposal.contentHash !== proposal.contentHash) {
      throw new Error("Host Harness proposal response changed committed identity.");
    }
    return { overlay: result.overlay, proposal: result.proposal };
  }

  private async transition(input: {
    runId: string;
    expectedRevision: number;
    edits: HarnessRunOverlay["edits"];
    updatedAt: string;
  }, operation: "append" | "freeze" | "abandon"): Promise<HarnessRunOverlay> {
    const current = await this.getHarnessRunOverlay(input.runId);
    if (!current || current.revision !== input.expectedRevision ||
        current.status === "abandoned" || (operation !== "abandon" && current.status !== "active")) {
      throw new Error("Hosted Harness overlay revision or status changed.");
    }
    if (operation === "append" && input.edits.length === 0) {
      throw new Error("Harness overlay append requires edits.");
    }
    const existingIds = new Set(current.edits.map((edit) => edit.id));
    for (const edit of input.edits) {
      if (existingIds.has(edit.id)) throw new Error(`Harness overlay edit id already exists: ${edit.id}.`);
      existingIds.add(edit.id);
    }
    const { contentHash: _hash, ...content } = current;
    const overlay = createHarnessRunOverlay({
      ...content,
      revision: current.revision + 1,
      status: operation === "append" ? "active" : operation === "freeze" ? "frozen" : "abandoned",
      edits: [...current.edits, ...input.edits],
      updatedAt: input.updatedAt,
    });
    return this.putHarnessRunOverlay({
      overlay, expectedRevision: current.revision,
      requestId: `harness-overlay:${overlay.runId}:${overlay.contentHash}`,
    });
  }
}
