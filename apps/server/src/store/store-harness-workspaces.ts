import {
  advanceHarnessWorkspace,
  createHarnessRunOverlay,
  HarnessAdvanceReceiptSchema,
  ImprovementApplyReceiptSchema,
  HarnessRefinerOutcomeSchema,
  ImprovementObservationSchema,
  ImprovementRouteDecisionSchema,
  HarnessImprovementProposalSchema,
  HarnessOverlayMergeReceiptSchema,
  HarnessRunOverlaySchema,
  HarnessTargetedValidationReceiptSchema,
  HarnessWorkspaceSchema,
  RefinementTriggerDecisionSchema,
  rollbackHarnessWorkspace,
  type HarnessAdvanceReceipt,
  type HarnessImprovementProposal,
  type HarnessOverlayMergeReceipt,
  type HarnessRunOverlay,
  type HarnessTargetedValidationReceipt,
  type HarnessWorkspace,
  type ImprovementApplyReceipt,
  type HarnessRefinerOutcome,
  type ImprovementObservation,
  type ImprovementRouteDecision,
  type RefinementTriggerDecision,
} from "@openpond/contracts";
import {
  AgentSnapshotSchema,
  HarnessReleaseSchema,
  type AgentSnapshot,
  type HarnessRelease,
  type ImmutableReleaseRef,
} from "@openpond/evals";
import { z } from "zod";

import type { PayloadRow } from "../types.js";
import { SqliteSidebarFileBookmarkStore } from "./store-sidebar-file-bookmarks.js";

export const LocalHarnessReleaseRecordSchema = z
  .object({
    schemaVersion: z.literal("openpond.localHarnessReleaseRecord.v1"),
    workspaceId: z.string().trim().min(1).max(240),
    sourceRevision: z.string().trim().min(1).max(500),
    agentSnapshot: AgentSnapshotSchema,
    harnessRelease: HarnessReleaseSchema,
    bundlePath: z.string().trim().min(1).max(8_192),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((record, context) => {
    if (
      record.harnessRelease.agentSnapshot.id !== record.agentSnapshot.id ||
      record.harnessRelease.agentSnapshot.contentHash !== record.agentSnapshot.contentHash
    ) {
      context.addIssue({
        code: "custom",
        message: "Harness release must bind the stored Agent snapshot",
        path: ["harnessRelease", "agentSnapshot"],
      });
    }
  });

type HarnessImprovementArtifact =
  | HarnessRunOverlay
  | HarnessImprovementProposal
  | HarnessTargetedValidationReceipt
  | HarnessOverlayMergeReceipt
  | ImprovementObservation
  | RefinementTriggerDecision
  | ImprovementRouteDecision
  | ImprovementApplyReceipt
  | HarnessRefinerOutcome;

export type HarnessImprovementArtifactKind =
  | "run_overlay"
  | "proposal"
  | "targeted_validation"
  | "merge_receipt"
  | "observation"
  | "trigger_decision"
  | "route_decision"
  | "apply_receipt"
  | "refiner_outcome";

const ARTIFACT_SCHEMAS = {
  run_overlay: HarnessRunOverlaySchema,
  proposal: HarnessImprovementProposalSchema,
  targeted_validation: HarnessTargetedValidationReceiptSchema,
  merge_receipt: HarnessOverlayMergeReceiptSchema,
  observation: ImprovementObservationSchema,
  trigger_decision: RefinementTriggerDecisionSchema,
  route_decision: ImprovementRouteDecisionSchema,
  apply_receipt: ImprovementApplyReceiptSchema,
  refiner_outcome: HarnessRefinerOutcomeSchema,
} as const;

export class SqliteHarnessWorkspaceStore extends SqliteSidebarFileBookmarkStore {
  async createHarnessWorkspace(input: HarnessWorkspace): Promise<HarnessWorkspace> {
    const workspace = HarnessWorkspaceSchema.parse(input);
    await this.ready;
    const write = this.writeQueue.then(() =>
      this.run(
        `INSERT INTO harness_workspaces (
           id, owner_kind, owner_id, location, revision, source_revision,
           channel_revision, current_release_hash, payload, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        workspaceParams(workspace),
      ),
    );
    this.writeQueue = write.catch(() => undefined);
    await write;
    return workspace;
  }

  async createHarnessWorkspaceWithRelease(input: {
    workspace: HarnessWorkspace;
    release: LocalHarnessReleaseRecord;
  }): Promise<{ workspace: HarnessWorkspace; release: LocalHarnessReleaseRecord }> {
    const workspace = HarnessWorkspaceSchema.parse(input.workspace);
    const release = LocalHarnessReleaseRecordSchema.parse(input.release);
    if (
      release.workspaceId !== workspace.id ||
      workspace.currentChannel.release?.id !== release.harnessRelease.id ||
      workspace.currentChannel.release.contentHash !== release.harnessRelease.contentHash ||
      workspace.sourceRevision !== release.sourceRevision
    ) {
      throw new Error("Initial Harness workspace and release record are not bound to the same source and release.");
    }
    await this.ready;
    const write = this.writeQueue.then(async () => {
      await this.exec("BEGIN IMMEDIATE");
      try {
        await this.run(
          `INSERT INTO harness_workspaces (
             id, owner_kind, owner_id, location, revision, source_revision,
             channel_revision, current_release_hash, payload, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          workspaceParams(workspace),
        );
        await this.run(
          `INSERT INTO harness_release_records (
             content_hash, id, workspace_id, source_revision, bundle_path, payload, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            release.harnessRelease.contentHash,
            release.harnessRelease.id,
            release.workspaceId,
            release.sourceRevision,
            release.bundlePath,
            JSON.stringify(release),
            release.createdAt,
          ],
        );
        await this.exec("COMMIT");
      } catch (error) {
        await this.exec("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return { workspace, release };
  }

  async getHarnessWorkspace(id: string): Promise<HarnessWorkspace | null> {
    await this.ready;
    await this.writeQueue;
    return this.readHarnessWorkspace(id);
  }

  async listHarnessWorkspaces(input?: {
    ownerKind?: "personal" | "team";
    ownerId?: string;
  }): Promise<HarnessWorkspace[]> {
    await this.ready;
    await this.writeQueue;
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (input?.ownerKind) {
      clauses.push("owner_kind = ?");
      params.push(input.ownerKind);
    }
    if (input?.ownerId) {
      clauses.push("owner_id = ?");
      params.push(input.ownerId);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = await this.all<PayloadRow>(
      `SELECT payload FROM harness_workspaces${where} ORDER BY updated_at DESC, id ASC`,
      params,
    );
    return rows.map((row) => HarnessWorkspaceSchema.parse(JSON.parse(row.payload)));
  }

  async selectHarnessWorkspace(input: {
    ownerKind: "personal" | "team";
    ownerId: string;
    workspaceId: string;
    updatedAt: string;
  }): Promise<HarnessWorkspace> {
    await this.ready;
    let selected: HarnessWorkspace | null = null;
    const write = this.writeQueue.then(async () => {
      selected = await this.requireHarnessWorkspace(input.workspaceId);
      if (
        selected.ownerScope.kind !== input.ownerKind ||
        selected.ownerScope.id !== input.ownerId
      ) {
        throw new Error("A Harness workspace can only be selected by its owner scope.");
      }
      await this.run(
        `INSERT INTO harness_workspace_selections (owner_kind, owner_id, workspace_id, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(owner_kind, owner_id) DO UPDATE SET
           workspace_id = excluded.workspace_id,
           updated_at = excluded.updated_at`,
        [input.ownerKind, input.ownerId, input.workspaceId, input.updatedAt],
      );
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    if (!selected) throw new Error("Harness workspace selection did not produce a result.");
    return selected;
  }

  async getSelectedHarnessWorkspace(input: {
    ownerKind: "personal" | "team";
    ownerId: string;
  }): Promise<HarnessWorkspace | null> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<{ workspace_id: string }>(
      `SELECT workspace_id FROM harness_workspace_selections
       WHERE owner_kind = ? AND owner_id = ?`,
      [input.ownerKind, input.ownerId],
    );
    return row ? this.readHarnessWorkspace(row.workspace_id) : null;
  }

  async updateHarnessWorkspaceSourceRevisionAtomically(input: {
    workspaceId: string;
    expectedWorkspaceRevision: number;
    expectedSourceRevision: string;
    nextSourceRevision: string;
    updatedAt: string;
  }): Promise<HarnessWorkspace> {
    await this.ready;
    let result: HarnessWorkspace | null = null;
    const write = this.writeQueue.then(async () => {
      await this.exec("BEGIN IMMEDIATE");
      try {
        const workspace = await this.requireHarnessWorkspace(input.workspaceId);
        if (
          workspace.revision !== input.expectedWorkspaceRevision ||
          workspace.sourceRevision !== input.expectedSourceRevision
        ) {
          throw new Error("Harness workspace changed before the source revision could be recorded.");
        }
        result = HarnessWorkspaceSchema.parse({
          ...workspace,
          sourceRevision: input.nextSourceRevision,
          revision: workspace.revision + 1,
          dirty: true,
          updatedAt: input.updatedAt,
        });
        await this.updateHarnessWorkspace(result);
        await this.exec("COMMIT");
      } catch (error) {
        await this.exec("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    if (!result) throw new Error("Harness source revision update did not produce a result.");
    return result;
  }

  async saveHarnessReleaseRecord(
    input: LocalHarnessReleaseRecord,
  ): Promise<LocalHarnessReleaseRecord> {
    const record = LocalHarnessReleaseRecordSchema.parse(input);
    await this.ready;
    const write = this.writeQueue.then(async () => {
      if (!(await this.readHarnessWorkspace(record.workspaceId))) {
        throw new Error(`Harness workspace ${record.workspaceId} does not exist.`);
      }
      await this.run(
        `INSERT OR IGNORE INTO harness_release_records (
           content_hash, id, workspace_id, source_revision, bundle_path, payload, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          record.harnessRelease.contentHash,
          record.harnessRelease.id,
          record.workspaceId,
          record.sourceRevision,
          record.bundlePath,
          JSON.stringify(record),
          record.createdAt,
        ],
      );
      const existing = await this.readHarnessReleaseRecord(record.harnessRelease.contentHash);
      if (!existing || JSON.stringify(existing) !== JSON.stringify(record)) {
        throw new Error("An immutable Harness release hash already has different registry content.");
      }
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return record;
  }

  async getHarnessReleaseRecord(contentHash: string): Promise<LocalHarnessReleaseRecord | null> {
    await this.ready;
    await this.writeQueue;
    return this.readHarnessReleaseRecord(contentHash);
  }

  async listHarnessReleaseRecords(workspaceId: string): Promise<LocalHarnessReleaseRecord[]> {
    await this.ready;
    await this.writeQueue;
    const rows = await this.all<PayloadRow>(
      `SELECT payload FROM harness_release_records
       WHERE workspace_id = ? ORDER BY created_at DESC, id ASC`,
      [workspaceId],
    );
    return rows.map((row) => LocalHarnessReleaseRecordSchema.parse(JSON.parse(row.payload)));
  }

  async saveHarnessImprovementArtifact(
    workspaceId: string,
    kind: HarnessImprovementArtifactKind,
    input: HarnessImprovementArtifact,
  ): Promise<HarnessImprovementArtifact> {
    const artifact = ARTIFACT_SCHEMAS[kind].parse(input) as HarnessImprovementArtifact;
    await this.ready;
    const write = this.writeQueue.then(async () => {
      if (!(await this.readHarnessWorkspace(workspaceId))) {
        throw new Error(`Harness workspace ${workspaceId} does not exist.`);
      }
      await this.insertHarnessImprovementArtifact(workspaceId, kind, artifact);
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return artifact;
  }

  async listHarnessImprovementArtifacts(
    workspaceId: string,
    kind: HarnessImprovementArtifactKind,
    limit = 100,
  ): Promise<HarnessImprovementArtifact[]> {
    await this.ready;
    await this.writeQueue;
    const boundedLimit = Math.max(1, Math.min(1_000, Math.trunc(limit)));
    const rows = await this.all<PayloadRow>(
      `SELECT payload FROM harness_improvement_artifacts
       WHERE workspace_id = ? AND kind = ?
       ORDER BY created_at DESC, id ASC LIMIT ?`,
      [workspaceId, kind, boundedLimit],
    );
    return rows.map((row) =>
      ARTIFACT_SCHEMAS[kind].parse(JSON.parse(row.payload)) as HarnessImprovementArtifact,
    );
  }

  async createHarnessRunOverlay(input: HarnessRunOverlay): Promise<HarnessRunOverlay> {
    const overlay = HarnessRunOverlaySchema.parse(input);
    if (overlay.revision !== 0 || overlay.status !== "active") {
      throw new Error("A new Harness run overlay must be active at revision 0.");
    }
    await this.ready;
    const write = this.writeQueue.then(async () => {
      await this.exec("BEGIN IMMEDIATE");
      try {
        const workspace = await this.requireHarnessWorkspace(
          overlay.workspace.workspaceId,
        );
        if (
          workspace.revision !== overlay.workspace.revision ||
          workspace.sourceRevision !== overlay.workspace.sourceRevision ||
          workspace.currentChannel.revision !== overlay.workspace.channelRevision
        ) {
          throw new Error("Harness run overlay is not bound to the exact workspace revision.");
        }
        const release = await this.readHarnessReleaseRecord(
          overlay.baseHarnessRelease.contentHash,
        );
        if (
          !release ||
          release.harnessRelease.id !== overlay.baseHarnessRelease.id ||
          release.workspaceId !== workspace.id
        ) {
          throw new Error("Harness run overlay base release is not present in the workspace registry.");
        }
        const existing = await this.readHarnessRunOverlay(overlay.runId);
        if (existing) {
          if (existing.contentHash !== overlay.contentHash) {
            throw new Error("Harness run already has a different overlay.");
          }
          await this.exec("COMMIT");
          return;
        }
        await this.run(
          `INSERT INTO harness_run_overlays (
             run_id, overlay_id, workspace_id, revision, status, payload,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            overlay.runId,
            overlay.id,
            workspace.id,
            overlay.revision,
            overlay.status,
            JSON.stringify(overlay),
            overlay.createdAt,
            overlay.updatedAt,
          ],
        );
        await this.insertHarnessImprovementArtifact(
          workspace.id,
          "run_overlay",
          overlay,
        );
        await this.exec("COMMIT");
      } catch (error) {
        await this.exec("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return overlay;
  }

  async getHarnessRunOverlay(runId: string): Promise<HarnessRunOverlay | null> {
    await this.ready;
    await this.writeQueue;
    return this.readHarnessRunOverlay(runId);
  }

  async appendHarnessRunOverlayEditsAtomically(input: {
    runId: string;
    expectedRevision: number;
    edits: HarnessRunOverlay["edits"];
    updatedAt: string;
  }): Promise<HarnessRunOverlay> {
    return this.transitionHarnessRunOverlayAtomically({
      runId: input.runId,
      expectedRevision: input.expectedRevision,
      operation: "append",
      edits: input.edits,
      updatedAt: input.updatedAt,
    });
  }

  async freezeHarnessRunOverlayAtomically(input: {
    runId: string;
    expectedRevision: number;
    updatedAt: string;
  }): Promise<HarnessRunOverlay> {
    return this.transitionHarnessRunOverlayAtomically({
      ...input,
      operation: "freeze",
      edits: [],
    });
  }

  async abandonHarnessRunOverlayAtomically(input: {
    runId: string;
    expectedRevision: number;
    updatedAt: string;
  }): Promise<HarnessRunOverlay> {
    return this.transitionHarnessRunOverlayAtomically({
      ...input,
      operation: "abandon",
      edits: [],
    });
  }

  async restoreHarnessRunOverlayAtomically(input: {
    runId: string;
    expectedRevision: number;
    restoreRevision: number;
    updatedAt: string;
  }): Promise<HarnessRunOverlay> {
    return this.transitionHarnessRunOverlayAtomically({
      runId: input.runId,
      expectedRevision: input.expectedRevision,
      operation: "restore",
      edits: [],
      restoreRevision: input.restoreRevision,
      updatedAt: input.updatedAt,
    });
  }

  async freezeHarnessRunOverlayWithProposalAtomically(input: {
    runId: string;
    expectedRevision: number;
    edits: HarnessRunOverlay["edits"];
    updatedAt: string;
    buildProposal: (frozenOverlay: HarnessRunOverlay) => HarnessImprovementProposal;
  }): Promise<{ overlay: HarnessRunOverlay; proposal: HarnessImprovementProposal }> {
    await this.ready;
    let result: {
      overlay: HarnessRunOverlay;
      proposal: HarnessImprovementProposal;
    } | null = null;
    const write = this.writeQueue.then(async () => {
      await this.exec("BEGIN IMMEDIATE");
      try {
        const current = await this.readHarnessRunOverlay(input.runId);
        if (!current) throw new Error(`Harness run overlay ${input.runId} does not exist.`);
        if (current.revision !== input.expectedRevision) {
          throw new Error(
            `Harness run overlay revision conflict: expected ${input.expectedRevision}, current ${current.revision}.`,
          );
        }
        if (current.status !== "active") {
          throw new Error("Only an active Harness run overlay can accept a Refiner proposal.");
        }
        const duplicateEditIds = input.edits
          .map((edit) => edit.id)
          .filter((id, index, ids) => ids.indexOf(id) !== index);
        if (duplicateEditIds.length > 0) {
          throw new Error(`Harness overlay edit ids must be unique: ${duplicateEditIds.join(", ")}.`);
        }
        const existingEditIds = new Set(current.edits.map((edit) => edit.id));
        const reused = input.edits.find((edit) => existingEditIds.has(edit.id));
        if (reused) throw new Error(`Harness overlay edit id already exists: ${reused.id}.`);

        const { contentHash: _contentHash, ...content } = current;
        const overlay = createHarnessRunOverlay({
          ...content,
          revision: current.revision + 1,
          status: "frozen",
          edits: [...current.edits, ...input.edits],
          updatedAt: input.updatedAt,
        });
        const proposal = HarnessImprovementProposalSchema.parse(
          input.buildProposal(overlay),
        );
        if (
          proposal.overlay.id !== overlay.id ||
          proposal.overlay.revision !== overlay.revision ||
          proposal.overlay.contentHash !== overlay.contentHash
        ) {
          throw new Error("Refiner proposal is not bound to the atomically frozen overlay.");
        }
        if (
          proposal.baseHarnessRelease.id !== overlay.baseHarnessRelease.id ||
          proposal.baseHarnessRelease.contentHash !==
            overlay.baseHarnessRelease.contentHash
        ) {
          throw new Error("Refiner proposal base release differs from the run overlay.");
        }
        if (JSON.stringify(proposal.edits) !== JSON.stringify(input.edits)) {
          throw new Error("Refiner proposal edits differ from the atomically applied edits.");
        }

        await this.run(
          `UPDATE harness_run_overlays SET
             revision = ?, status = ?, payload = ?, updated_at = ?
           WHERE run_id = ? AND revision = ?`,
          [
            overlay.revision,
            overlay.status,
            JSON.stringify(overlay),
            overlay.updatedAt,
            current.runId,
            current.revision,
          ],
        );
        await this.insertHarnessImprovementArtifact(
          current.workspace.workspaceId,
          "run_overlay",
          overlay,
        );
        await this.insertHarnessImprovementArtifact(
          current.workspace.workspaceId,
          "proposal",
          proposal,
        );
        await this.exec("COMMIT");
        result = { overlay, proposal };
      } catch (error) {
        await this.exec("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    if (!result) throw new Error("Atomic Harness Refiner proposal did not produce a result.");
    return result;
  }

  async advanceHarnessWorkspaceAtomically(input: {
    receiptId: string;
    workspaceId: string;
    proposal: HarnessImprovementProposal;
    validations: HarnessTargetedValidationReceipt[];
    nextRelease: ImmutableReleaseRef;
    nextSourceRevision: string;
    now: string;
  }): Promise<{ workspace: HarnessWorkspace; receipt: HarnessAdvanceReceipt }> {
    await this.ready;
    let result: { workspace: HarnessWorkspace; receipt: HarnessAdvanceReceipt } | null = null;
    const write = this.writeQueue.then(async () => {
      await this.exec("BEGIN IMMEDIATE");
      try {
        const existing = await this.readHarnessAdvanceReceipt(input.receiptId);
        if (existing) {
          result = {
            workspace: await this.requireHarnessWorkspace(input.workspaceId),
            receipt: existing,
          };
          await this.exec("COMMIT");
          return;
        }
        const workspace = await this.requireHarnessWorkspace(input.workspaceId);
        const release = await this.readHarnessReleaseRecord(input.nextRelease.contentHash);
        if (
          !release ||
          release.harnessRelease.id !== input.nextRelease.id ||
          release.workspaceId !== input.workspaceId
        ) {
          throw new Error("Candidate Harness release is not present in this workspace registry.");
        }
        result = advanceHarnessWorkspace({ ...input, workspace });
        if (result.receipt.decision === "advanced") {
          await this.updateHarnessWorkspace(result.workspace);
        }
        await this.insertHarnessAdvanceReceipt(result.receipt);
        await this.exec("COMMIT");
      } catch (error) {
        await this.exec("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    if (!result) throw new Error("Harness workspace advancement did not produce a result.");
    return result;
  }

  async rollbackHarnessWorkspaceAtomically(input: {
    receiptId: string;
    workspaceId: string;
    expectedWorkspaceRevision: number;
    expectedChannelRevision: number;
    targetRelease: ImmutableReleaseRef;
    targetSourceRevision: string;
    rollbackOf: ImmutableReleaseRef;
    now: string;
  }): Promise<{ workspace: HarnessWorkspace; receipt: HarnessAdvanceReceipt }> {
    await this.ready;
    let result: { workspace: HarnessWorkspace; receipt: HarnessAdvanceReceipt } | null = null;
    const write = this.writeQueue.then(async () => {
      await this.exec("BEGIN IMMEDIATE");
      try {
        const existing = await this.readHarnessAdvanceReceipt(input.receiptId);
        if (existing) {
          result = {
            workspace: await this.requireHarnessWorkspace(input.workspaceId),
            receipt: existing,
          };
          await this.exec("COMMIT");
          return;
        }
        const workspace = await this.requireHarnessWorkspace(input.workspaceId);
        const target = await this.readHarnessReleaseRecord(input.targetRelease.contentHash);
        if (!target || target.harnessRelease.id !== input.targetRelease.id) {
          throw new Error("Rollback target is not present in the local Harness registry.");
        }
        result = rollbackHarnessWorkspace({ ...input, workspace });
        if (result.receipt.decision === "rolled_back") {
          await this.updateHarnessWorkspace(result.workspace);
        }
        await this.insertHarnessAdvanceReceipt(result.receipt);
        await this.exec("COMMIT");
      } catch (error) {
        await this.exec("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    if (!result) throw new Error("Harness workspace rollback did not produce a result.");
    return result;
  }

  async listHarnessAdvanceReceipts(workspaceId: string): Promise<HarnessAdvanceReceipt[]> {
    await this.ready;
    await this.writeQueue;
    const rows = await this.all<PayloadRow>(
      `SELECT payload FROM harness_advance_receipts
       WHERE workspace_id = ? ORDER BY created_at ASC, id ASC`,
      [workspaceId],
    );
    return rows.map((row) => HarnessAdvanceReceiptSchema.parse(JSON.parse(row.payload)));
  }

  private async transitionHarnessRunOverlayAtomically(input: {
    runId: string;
    expectedRevision: number;
    operation: "append" | "freeze" | "abandon" | "restore";
    edits: HarnessRunOverlay["edits"];
    restoreRevision?: number;
    updatedAt: string;
  }): Promise<HarnessRunOverlay> {
    await this.ready;
    let result: HarnessRunOverlay | null = null;
    const write = this.writeQueue.then(async () => {
      await this.exec("BEGIN IMMEDIATE");
      try {
        const current = await this.readHarnessRunOverlay(input.runId);
        if (!current) throw new Error(`Harness run overlay ${input.runId} does not exist.`);
        if (current.revision !== input.expectedRevision) {
          throw new Error(
            `Harness run overlay revision conflict: expected ${input.expectedRevision}, current ${current.revision}.`,
          );
        }
        if (current.status === "abandoned") {
          throw new Error("An abandoned Harness run overlay cannot be changed.");
        }
        if (input.operation === "append" && current.status !== "active") {
          throw new Error("Only an active Harness run overlay accepts edits.");
        }
        if (input.operation === "freeze" && current.status !== "active") {
          throw new Error("Only an active Harness run overlay can be frozen.");
        }
        const duplicateEditIds = input.edits
          .map((edit) => edit.id)
          .filter((id, index, ids) => ids.indexOf(id) !== index);
        if (duplicateEditIds.length > 0) {
          throw new Error(`Harness overlay edit ids must be unique: ${duplicateEditIds.join(", ")}.`);
        }
        const existingEditIds = new Set(current.edits.map((edit) => edit.id));
        const reusedEditId = input.edits.find((edit) => existingEditIds.has(edit.id));
        if (reusedEditId) {
          throw new Error(`Harness overlay edit id already exists: ${reusedEditId.id}.`);
        }

        let nextEdits = [...current.edits, ...input.edits];
        let nextStatus: HarnessRunOverlay["status"] = current.status;
        const metadata = { ...current.metadata };
        if (input.operation === "freeze") nextStatus = "frozen";
        if (input.operation === "abandon") nextStatus = "abandoned";
        if (input.operation === "restore") {
          if (input.restoreRevision === undefined) {
            throw new Error("Harness overlay restore requires a source revision.");
          }
          const restored = await this.readHarnessRunOverlayRevision(
            current.id,
            input.restoreRevision,
          );
          if (
            !restored ||
            restored.runId !== current.runId ||
            restored.baseHarnessRelease.id !== current.baseHarnessRelease.id ||
            restored.baseHarnessRelease.contentHash !==
              current.baseHarnessRelease.contentHash
          ) {
            throw new Error("Harness overlay restore revision is unavailable or incompatible.");
          }
          nextEdits = restored.edits;
          nextStatus = "active";
          metadata.restoredFromRevision = restored.revision;
        }
        const { contentHash: _contentHash, ...currentContent } = current;
        result = createHarnessRunOverlay({
          ...currentContent,
          revision: current.revision + 1,
          status: nextStatus,
          edits: nextEdits,
          updatedAt: input.updatedAt,
          metadata,
        });
        await this.run(
          `UPDATE harness_run_overlays SET
             revision = ?, status = ?, payload = ?, updated_at = ?
           WHERE run_id = ? AND revision = ?`,
          [
            result.revision,
            result.status,
            JSON.stringify(result),
            result.updatedAt,
            current.runId,
            current.revision,
          ],
        );
        await this.insertHarnessImprovementArtifact(
          current.workspace.workspaceId,
          "run_overlay",
          result,
        );
        await this.exec("COMMIT");
      } catch (error) {
        await this.exec("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    if (!result) throw new Error("Harness run overlay transition did not produce a result.");
    return result;
  }

  private async readHarnessRunOverlay(runId: string): Promise<HarnessRunOverlay | null> {
    const row = await this.get<PayloadRow>(
      "SELECT payload FROM harness_run_overlays WHERE run_id = ?",
      [runId],
    );
    return row ? HarnessRunOverlaySchema.parse(JSON.parse(row.payload)) : null;
  }

  private async readHarnessRunOverlayRevision(
    overlayId: string,
    revision: number,
  ): Promise<HarnessRunOverlay | null> {
    const row = await this.get<PayloadRow>(
      `SELECT payload FROM harness_improvement_artifacts
       WHERE id = ? AND kind = 'run_overlay'
         AND CAST(json_extract(payload, '$.revision') AS INTEGER) = ?
       ORDER BY created_at DESC LIMIT 1`,
      [overlayId, revision],
    );
    return row ? HarnessRunOverlaySchema.parse(JSON.parse(row.payload)) : null;
  }

  private async insertHarnessImprovementArtifact(
    workspaceId: string,
    kind: HarnessImprovementArtifactKind,
    artifact: HarnessImprovementArtifact,
  ): Promise<void> {
    const serialized = JSON.stringify(artifact);
    const sameHash = await this.get<PayloadRow>(
      "SELECT payload FROM harness_improvement_artifacts WHERE content_hash = ?",
      [artifact.contentHash],
    );
    if (sameHash) {
      if (sameHash.payload !== serialized) {
        throw new Error("An immutable Harness improvement artifact hash already has different content.");
      }
      return;
    }
    const sameIdentity = await this.all<PayloadRow>(
      `SELECT payload FROM harness_improvement_artifacts
       WHERE id = ? AND kind = ?`,
      [artifact.id, kind],
    );
    if (kind !== "run_overlay" && sameIdentity.length > 0) {
      throw new Error("An immutable Harness improvement artifact id already has different content.");
    }
    if (kind === "run_overlay") {
      const revision = (artifact as HarnessRunOverlay).revision;
      const conflictingRevision = sameIdentity
        .map((row) => HarnessRunOverlaySchema.parse(JSON.parse(row.payload)))
        .find((overlay) => overlay.revision === revision);
      if (conflictingRevision) {
        throw new Error("A Harness run overlay revision already has different content.");
      }
    }
    await this.run(
      `INSERT INTO harness_improvement_artifacts (
         content_hash, id, workspace_id, kind, payload, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        artifact.contentHash,
        artifact.id,
        workspaceId,
        kind,
        serialized,
        artifact.createdAt,
      ],
    );
  }

  private async requireHarnessWorkspace(id: string): Promise<HarnessWorkspace> {
    const workspace = await this.readHarnessWorkspace(id);
    if (!workspace) throw new Error(`Harness workspace ${id} does not exist.`);
    return workspace;
  }

  private async readHarnessWorkspace(id: string): Promise<HarnessWorkspace | null> {
    const row = await this.get<PayloadRow>(
      "SELECT payload FROM harness_workspaces WHERE id = ?",
      [id],
    );
    return row ? HarnessWorkspaceSchema.parse(JSON.parse(row.payload)) : null;
  }

  private async updateHarnessWorkspace(workspace: HarnessWorkspace): Promise<void> {
    const parsed = HarnessWorkspaceSchema.parse(workspace);
    await this.run(
      `UPDATE harness_workspaces SET
         owner_kind = ?, owner_id = ?, location = ?, revision = ?, source_revision = ?,
         channel_revision = ?, current_release_hash = ?, payload = ?, updated_at = ?
       WHERE id = ?`,
      [
        parsed.ownerScope.kind,
        parsed.ownerScope.id,
        parsed.location,
        parsed.revision,
        parsed.sourceRevision,
        parsed.currentChannel.revision,
        parsed.currentChannel.release?.contentHash ?? null,
        JSON.stringify(parsed),
        parsed.updatedAt,
        parsed.id,
      ],
    );
  }

  private async readHarnessReleaseRecord(contentHash: string): Promise<LocalHarnessReleaseRecord | null> {
    const row = await this.get<PayloadRow>(
      "SELECT payload FROM harness_release_records WHERE content_hash = ?",
      [contentHash],
    );
    return row ? LocalHarnessReleaseRecordSchema.parse(JSON.parse(row.payload)) : null;
  }

  private async readHarnessAdvanceReceipt(id: string): Promise<HarnessAdvanceReceipt | null> {
    const row = await this.get<PayloadRow>(
      "SELECT payload FROM harness_advance_receipts WHERE id = ?",
      [id],
    );
    return row ? HarnessAdvanceReceiptSchema.parse(JSON.parse(row.payload)) : null;
  }

  private async insertHarnessAdvanceReceipt(receipt: HarnessAdvanceReceipt): Promise<void> {
    const parsed = HarnessAdvanceReceiptSchema.parse(receipt);
    await this.run(
      `INSERT INTO harness_advance_receipts (
         content_hash, id, workspace_id, decision, payload, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        parsed.contentHash,
        parsed.id,
        parsed.workspaceId,
        parsed.decision,
        JSON.stringify(parsed),
        parsed.createdAt,
      ],
    );
  }
}

function workspaceParams(workspace: HarnessWorkspace): unknown[] {
  return [
    workspace.id,
    workspace.ownerScope.kind,
    workspace.ownerScope.id,
    workspace.location,
    workspace.revision,
    workspace.sourceRevision,
    workspace.currentChannel.revision,
    workspace.currentChannel.release?.contentHash ?? null,
    JSON.stringify(workspace),
    workspace.createdAt,
    workspace.updatedAt,
  ];
}

export type LocalHarnessReleaseRecord = z.infer<typeof LocalHarnessReleaseRecordSchema> & {
  agentSnapshot: AgentSnapshot;
  harnessRelease: HarnessRelease;
};
