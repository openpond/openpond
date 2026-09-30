import { randomUUID } from "node:crypto";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { HOST_STORAGE_CONTRACT_VERSION, type AgentHostStorageClient,
  type HarnessReviewStorageParamsSchema } from "@openpond/agent-runtime";
import { HarnessAdvanceReceiptSchema, HarnessWorkspaceSchema,
  RuntimeEventSchema, SessionSchema, TurnSchema, RefinementTriggerDecisionSchema,
  type RefinementTriggerDecision, type ModelUsageRecord, type RuntimeEvent } from "@openpond/contracts";
import { contentHash } from "@openpond/harness";
import { z } from "zod";
import type { HarnessReviewStateStore } from "./harness-state-store.js";
import { HostedHarnessOverlayStorage } from "./hosted-harness-overlay-storage.js";
import { HostedModelUsageStorage } from "./hosted-approval-usage-storage.js";
import { LocalHarnessReleaseRecordSchema } from "./store-harness-release-record.js";
import { HARNESS_IMPROVEMENT_ARTIFACT_SCHEMAS } from "./store-harness-workspace-artifacts.js";
import { compileLocalHarnessSource, localHarnessWorkspacePaths } from "../harness/local-harness-workspace-service.js";

type Params = z.infer<typeof HarnessReviewStorageParamsSchema>;
const HarnessMemoryEntrySchema = z.object({ schemaVersion: z.literal("openpond.harnessMemoryEntry.v1"),
  id: z.string(), workspaceId: z.string(), key: z.string(), content: z.string(), tags: z.array(z.string()),
  revision: z.number().int().positive(), status: z.enum(["active", "deleted"]),
  sourceRunId: z.string().nullable(), sourceProposal: z.object({ id: z.string(), contentHash: z.string() }).nullable(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(), contentHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const artifactCursor = z.object({ createdAt: z.string().datetime(), id: z.string() }).strict();
const artifactPage = z.object({ entries: z.array(z.unknown()).max(100), nextBefore: artifactCursor.nullable() }).strict();
const transition = z.object({ workspace: HarnessWorkspaceSchema, receipt: HarnessAdvanceReceiptSchema }).strict();

/** The shared background review engine uses host-owned state and reconstructible source caches. */
export class HostedHarnessReviewStorage implements HarnessReviewStateStore {
  readonly harnessStoragePlacement = "hosted" as const;
  private reviewSessionId: string | null = null;
  private readonly overlay: HostedHarnessOverlayStorage;
  private readonly usage: HostedModelUsageStorage;

  constructor(private readonly client: AgentHostStorageClient, private readonly storeDir: string) {
    this.usage = new HostedModelUsageStorage(client);
    this.overlay = new HostedHarnessOverlayStorage({ request: async request => {
      if (request.operation === "harness/overlay/get") return this.request({ action: "overlay_get", ...request.params });
      if (request.operation === "harness/overlay/freezeProposal") {
        return this.request({ action: "overlay_freeze", ...request.params }, request.requestId);
      }
      return client.request(request);
    } });
  }
  private request(params: Params, requestId: string = randomUUID()): Promise<unknown> {
    return this.client.request({ contractVersion: HOST_STORAGE_CONTRACT_VERSION, requestId,
      operation: "harness/review/execute", params }, params.action === "release_put" ? 60_000 : 15_000);
  }
  private sessionId(): string {
    if (!this.reviewSessionId) throw new Error("Hosted review memory requires an admitted review session.");
    return this.reviewSessionId;
  }

  async prepareReview(trigger: RefinementTriggerDecision): Promise<void> {
    const session = await this.getSession(trigger.runRef);
    if (!session) throw new Error("Hosted review session is unavailable.");
    this.reviewSessionId = session.id;
    const overlay = await this.getHarnessRunOverlay(session.id);
    if (!overlay) throw new Error("Hosted review overlay is unavailable.");
    const workspace = await this.getHarnessWorkspace(overlay.workspace.workspaceId);
    if (!workspace?.currentChannel.release) throw new Error("Hosted review workspace release is unavailable.");
    const release = await this.getHarnessReleaseRecord(workspace.currentChannel.release.contentHash);
    if (!release || release.sourceRevision !== workspace.sourceRevision) throw new Error("Hosted review source binding changed.");
    const paths = localHarnessWorkspacePaths(this.storeDir, workspace.id);
    await mkdir(paths.root, { recursive: true, mode: 0o700 });
    await rm(paths.source, { recursive: true, force: true });
    await cp(path.join(release.bundlePath, "source"), paths.source, { recursive: true, force: false, errorOnExist: true });
    const compiled = await compileLocalHarnessSource({ workspaceId: workspace.id, sourceDir: paths.source });
    if (compiled.sourceRevision !== workspace.sourceRevision || compiled.harnessRelease.contentHash !== release.harnessRelease.contentHash) {
      throw new Error("Hosted review source cache differs from its immutable release.");
    }
  }
  getHarnessWorkspace: HarnessReviewStateStore["getHarnessWorkspace"] = async workspaceId =>
    HarnessWorkspaceSchema.nullable().parse(await this.request({ action: "workspace_get", workspaceId }));
  getHarnessReleaseRecord: HarnessReviewStateStore["getHarnessReleaseRecord"] = async hash =>
    LocalHarnessReleaseRecordSchema.nullable().parse(await this.request({ action: "release_get", contentHash: hash }));
  saveHarnessReleaseRecord: HarnessReviewStateStore["saveHarnessReleaseRecord"] = async record =>
    LocalHarnessReleaseRecordSchema.parse(await this.request({ action: "release_put", record }, `review-release:${record.harnessRelease.contentHash}`));
  getHarnessRunOverlay: HarnessReviewStateStore["getHarnessRunOverlay"] = id => this.overlay.getHarnessRunOverlay(id);
  createHarnessRunOverlay: HarnessReviewStateStore["createHarnessRunOverlay"] = overlay => this.overlay.createHarnessRunOverlay(overlay);
  freezeHarnessRunOverlayWithProposalAtomically: HarnessReviewStateStore["freezeHarnessRunOverlayWithProposalAtomically"] = input =>
    this.overlay.freezeHarnessRunOverlayWithProposalAtomically(input);
  getHarnessBackgroundReviewSettings: HarnessReviewStateStore["getHarnessBackgroundReviewSettings"] = async workspaceId => {
    return z.object({ enabled: z.boolean(), updatedAt: z.string().datetime().nullable() }).strict()
      .parse(await this.request({ action: "background_get", workspaceId }));
  };
  getHarnessMemory: HarnessReviewStateStore["getHarnessMemory"] = async (workspaceId, key) =>
    HarnessMemoryEntrySchema.nullable().parse(await this.request({ action: "memory_get", workspaceId, sessionId: this.sessionId(), key }));
  listHarnessMemories: HarnessReviewStateStore["listHarnessMemories"] = async (workspaceId, options = {}) => {
    const schema = z.object({ entries: z.array(HarnessMemoryEntrySchema).max(20),
      nextBefore: z.object({ updatedAt: z.string().datetime(), key: z.string() }).nullable() });
    const entries: z.infer<typeof HarnessMemoryEntrySchema>[] = [];
    let before: z.infer<typeof schema>["nextBefore"] = null;
    do {
      const page = schema.parse(await this.request({ action: "memory_page", workspaceId, sessionId: this.sessionId(),
        before, limit: 20, includeDeleted: options.includeDeleted ?? false }));
      entries.push(...page.entries);
      if (page.nextBefore && (!page.entries.length || contentHash(page.nextBefore) === contentHash(before))) throw new Error("Hosted memory cursor did not advance.");
      before = page.nextBefore;
    } while (before && entries.length < 1_000);
    if (before) throw new Error("Hosted review memory exceeds its bounded window.");
    return entries;
  };
  writeHarnessMemory: HarnessReviewStateStore["writeHarnessMemory"] = async input =>
    HarnessMemoryEntrySchema.parse(await this.request({ action: "memory_write", sessionId: this.sessionId(),
      input }, `review-memory:${contentHash(input)}`));
  saveHarnessImprovementArtifact: HarnessReviewStateStore["saveHarnessImprovementArtifact"] = async (workspaceId, kind, artifact) => {
    const params = { action: "artifact_put", workspaceId, kind, artifact };
    const parsed = (await import("@openpond/agent-runtime")).HarnessReviewStorageParamsSchema.parse(params);
    return HARNESS_IMPROVEMENT_ARTIFACT_SCHEMAS[kind].parse(await this.request(parsed, `review-artifact:${kind}:${artifact.contentHash}`));
  };
  listHarnessImprovementArtifacts: HarnessReviewStateStore["listHarnessImprovementArtifacts"] = async (workspaceId, kind, limit = 100) => {
    const entries: unknown[] = [];
    let before: z.infer<typeof artifactCursor> | null = null;
    const maximum = Math.min(Math.max(1, Math.trunc(limit)), 1_000);
    do {
      const params = (await import("@openpond/agent-runtime")).HarnessReviewStorageParamsSchema.parse({ action: "artifact_page", workspaceId,
        kind, before, limit: Math.min(100, maximum - entries.length) });
      const page = artifactPage.parse(await this.request(params));
      entries.push(...page.entries);
      if (page.nextBefore && (!page.entries.length || contentHash(page.nextBefore) === contentHash(before))) throw new Error("Hosted artifact cursor did not advance.");
      before = page.nextBefore;
    } while (before && entries.length < maximum);
    return entries.map(entry => HARNESS_IMPROVEMENT_ARTIFACT_SCHEMAS[kind].parse(entry));
  };
  listPendingHarnessRefinerTriggers: HarnessReviewStateStore["listPendingHarnessRefinerTriggers"] = async () => {
    // The selected owner workspace is obtained from the leased host, never from local state.
    const runtime = await import("./hosted-harness-runtime.js").then(module => module.loadHostedHarnessRuntime(this.client));
    if (!runtime) return [];
    const result: Awaited<ReturnType<HarnessReviewStateStore["listPendingHarnessRefinerTriggers"]>> = [];
    let before: z.infer<typeof artifactCursor> | null = null;
    do {
      const page = artifactPage.parse(await this.request({ action: "pending_page", workspaceId: runtime.workspace.id, before, limit: 100 }));
      result.push(...page.entries.map(entry => ({ workspaceId: runtime.workspace.id, trigger: RefinementTriggerDecisionSchema.parse(entry) })));
      if (page.nextBefore && (!page.entries.length || contentHash(page.nextBefore) === contentHash(before))) throw new Error("Hosted pending-review cursor did not advance.");
      before = page.nextBefore;
    } while (before && result.length < 1_000);
    if (before) throw new Error("Hosted pending reviews exceed the bounded recovery window.");
    return result;
  };
  advanceHarnessWorkspaceAtomically: HarnessReviewStateStore["advanceHarnessWorkspaceAtomically"] = async input =>
    transition.parse(await this.client.request({ contractVersion: HOST_STORAGE_CONTRACT_VERSION, requestId: input.receiptId,
      operation: "harness/workspace/transition", params: { action: "advance", ...input } }));
  advanceReviewedHarnessWorkspaceAtomically: HarnessReviewStateStore["advanceReviewedHarnessWorkspaceAtomically"] = async input =>
    transition.parse(await this.client.request({ contractVersion: HOST_STORAGE_CONTRACT_VERSION, requestId: input.receiptId,
      operation: "harness/workspace/transition", params: { action: "reviewedAdvance", ...input } }));
  rollbackHarnessWorkspaceAtomically: HarnessReviewStateStore["rollbackHarnessWorkspaceAtomically"] = async input =>
    transition.parse(await this.client.request({ contractVersion: HOST_STORAGE_CONTRACT_VERSION, requestId: input.receiptId,
      operation: "harness/workspace/transition", params: { action: "rollback", ...input } }));
  getSession: HarnessReviewStateStore["getSession"] = async sessionId => SessionSchema.nullable().parse(await this.request({ action: "session_get", sessionId }));
  getTurn: HarnessReviewStateStore["getTurn"] = async turnId => TurnSchema.nullable().parse(await this.request({ action: "turn_get", turnId }));
  updateTurn: HarnessReviewStateStore["updateTurn"] = async (turnId, updater) => {
    const current = await this.getTurn(turnId);
    if (!current) return null;
    const next = TurnSchema.parse(updater(current));
    const { harnessSnapshot: _old, ...oldFields } = current;
    const { harnessSnapshot: snapshot, ...nextFields } = next;
    if (!snapshot || contentHash(oldFields) !== contentHash(nextFields)) throw new Error("Hosted review may only restore a missing Harness snapshot.");
    return TurnSchema.parse(await this.request({ action: "snapshot_restore", turnId, expectedHash: contentHash(current), snapshot }));
  };
  turnsForSession: HarnessReviewStateStore["turnsForSession"] = async (sessionId, limit = 1_000) => {
    const schema = z.object({ entries: z.array(TurnSchema).max(100), nextBefore: z.number().int().positive().nullable() });
    const entries: z.infer<typeof TurnSchema>[] = [];
    let before: number | null = null;
    const maximum = Math.min(Math.max(1, Math.trunc(limit)), 1_000);
    do {
      const page = schema.parse(await this.request({ action: "turn_page", sessionId, before, limit: Math.min(100, maximum - entries.length) }));
      entries.push(...page.entries);
      if (page.nextBefore && (!page.entries.length || (before !== null && page.nextBefore >= before))) throw new Error("Hosted review turn cursor did not advance.");
      before = page.nextBefore;
    } while (before && entries.length < maximum);
    return entries.reverse();
  };
  runtimeEventsForTurn: HarnessReviewStateStore["runtimeEventsForTurn"] = async (turnId, query = {}) => {
    const schema = z.object({ entries: z.array(RuntimeEventSchema).max(100), nextAfterSequence: z.number().int().positive().nullable() });
    const entries: RuntimeEvent[] = [];
    let afterSequence = 0;
    const maximum = Math.min(query.limit ?? 10_000, 10_000);
    do {
      const page = schema.parse(await this.request({ action: "event_page", turnId, afterSequence,
        names: [...(query.names ?? [])], limit: Math.min(100, maximum - entries.length) }));
      entries.push(...page.entries);
      if (!page.nextAfterSequence) return entries;
      if (!page.entries.length || page.nextAfterSequence <= afterSequence) throw new Error("Hosted review event cursor did not advance.");
      afterSequence = page.nextAfterSequence;
    } while (entries.length < maximum);
    return entries;
  };
  listModelUsageRecords: HarnessReviewStateStore["listModelUsageRecords"] = query => this.usage.listModelUsageRecords(query);
  async appendRuntimeEvent(event: RuntimeEvent): Promise<RuntimeEvent> {
    return RuntimeEventSchema.parse(await this.request({ action: "event_append", event }, `review-event:${event.id}`));
  }
  async upsertModelUsageRecord(record: ModelUsageRecord): Promise<void> {
    await this.request({ action: "usage_put", record }, `review-usage:${contentHash(record)}`);
  }
}
