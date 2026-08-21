import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createHarnessImprovementProposal,
  createHarnessRunOverlay,
  createHarnessTargetedValidationReceipt,
  HarnessOverlayEditSchema,
  SessionSchema,
  TurnSchema,
  emptyOpenPondProfileState,
} from "@openpond/contracts";
import { contentHash } from "@openpond/harness";
import { afterEach, describe, expect, it } from "vitest";

import { SqliteStore } from "../store/store.js";
import {
  compileAndRegisterLocalHarnessRelease,
  compileLocalHarnessSource,
  createLocalHarnessWorkspace,
  forkLocalHarnessWorkspaceFromRelease,
  importProfileIntoLocalHarnessWorkspace,
  localHarnessWorkspacePaths,
  materializeLocalHarnessRelease,
} from "./local-harness-workspace-service.js";
import {
  loadSelectedLocalHarnessRuntime,
  loadSelectedLocalHarnessSkillRuntime,
} from "./local-harness-skill-runtime.js";
import { applyLocalHarnessRefinerProposal } from "./local-harness-refiner.js";
import { localHarnessReleaseDiffPayload } from "./local-harness-history.js";
import { recordLocalHarnessImprovementBoundary } from "./local-harness-improvement-observer.js";
import {
  ensureLocalHarnessRunOverlay,
  loadLocalHarnessRuntimeForAgentRun,
} from "./local-harness-run-overlay.js";

const NOW = "2026-08-05T14:00:00.000Z";
const LATER = "2026-08-05T14:05:00.000Z";

const cleanup: Array<{ directory: string; store: SqliteStore }> = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map(async ({ directory, store }) => {
      await store.close();
      await fs.rm(directory, { recursive: true, force: true });
    }),
  );
});

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openpond-harness-workspace-"));
  const store = new SqliteStore(directory);
  cleanup.push({ directory, store });
  const created = await createLocalHarnessWorkspace({
    store,
    storeDir: directory,
    id: "personal-default",
    ownerId: "desktop-personal",
    name: "Personal Harness",
    now: () => NOW,
  });
  await store.selectHarnessWorkspace({
    ownerKind: "personal",
    ownerId: "desktop-personal",
    workspaceId: created.workspace.id,
    updatedAt: NOW,
  });
  return { directory, store, ...created };
}

describe("local Harness workspace service", () => {
  it("creates a host-neutral source package and an immutable registered release", async () => {
    const { directory, store, workspace, release } = await fixture();
    const paths = localHarnessWorkspacePaths(directory, workspace.id);

    const manifest = JSON.parse(await fs.readFile(path.join(paths.source, "harness.json"), "utf8"));
    expect(manifest.schemaVersion).toBe("openpond.harnessSourceManifest.v1");
    expect(workspace.currentChannel.release).toEqual({
      id: release.harnessRelease.id,
      contentHash: release.harnessRelease.contentHash,
    });
    expect(await store.getHarnessReleaseRecord(release.harnessRelease.contentHash)).toEqual(release);

    const compiledAgain = await compileLocalHarnessSource({
      workspaceId: workspace.id,
      sourceDir: paths.source,
    });
    expect(compiledAgain.sourceRevision).toBe(workspace.sourceRevision);
    expect(compiledAgain.harnessRelease.contentHash).toBe(release.harnessRelease.contentHash);

    const rematerialized = await materializeLocalHarnessRelease({
      storeDir: directory,
      workspaceId: workspace.id,
      compiled: compiledAgain,
      createdAt: LATER,
    });
    await expect(store.saveHarnessReleaseRecord(rematerialized)).resolves.toEqual(
      rematerialized,
    );
    expect(
      (await store.getHarnessReleaseRecord(release.harnessRelease.contentHash))
        ?.createdAt,
    ).toBe(NOW);
  });

  it("builds a bounded source diff between immutable Harness releases", async () => {
    const { directory, store, workspace, release: base } = await fixture();
    const paths = localHarnessWorkspacePaths(directory, workspace.id);
    const instructionPath = path.join(paths.source, "instructions", "system.md");
    const previous = await fs.readFile(instructionPath, "utf8");
    const next = `${previous.trimEnd()}\n\nPrefer the bundled document runtime for DOCX work.\n`;
    await fs.writeFile(instructionPath, next);
    const candidate = await compileAndRegisterLocalHarnessRelease({
      store,
      storeDir: directory,
      workspaceId: workspace.id,
      now: () => LATER,
    });

    const diff = await localHarnessReleaseDiffPayload({
      store,
      storeDir: directory,
      request: {
        workspaceId: workspace.id,
        baseRelease: {
          id: base.harnessRelease.id,
          contentHash: base.harnessRelease.contentHash,
        },
        targetRelease: {
          id: candidate.release.harnessRelease.id,
          contentHash: candidate.release.harnessRelease.contentHash,
        },
      },
    });

    expect(diff).toMatchObject({
      baseRelease: {
        id: base.harnessRelease.id,
        contentHash: base.harnessRelease.contentHash,
      },
      targetRelease: {
        id: candidate.release.harnessRelease.id,
        contentHash: candidate.release.harnessRelease.contentHash,
      },
      filesChanged: 1,
    });
    expect(diff.additions).toBeGreaterThan(0);
    expect(diff.files).toEqual([
      expect.objectContaining({
        path: "instructions/system.md",
        status: "modified",
        content: null,
      }),
    ]);
    expect(diff.files[0]?.patch).toContain("diff --git a/instructions/system.md b/instructions/system.md");
    expect(diff.files[0]?.patch).toContain("+Prefer the bundled document runtime for DOCX work.");
  });

  it("forks an immutable Harness release into a native mutable workspace", async () => {
    const { directory, store, release } = await fixture();
    const forked = await forkLocalHarnessWorkspaceFromRelease({
      store,
      storeDir: directory,
      id: "personal-fork",
      ownerId: "desktop-personal",
      name: "Forked Personal Harness",
      sourceRelease: {
        id: release.harnessRelease.id,
        contentHash: release.harnessRelease.contentHash,
      },
      now: () => LATER,
    });

    expect(forked.workspace.id).toBe("personal-fork");
    expect(forked.release.harnessRelease.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "instructions/system.md" }),
      ]),
    );
    expect(await store.getHarnessReleaseRecord(release.harnessRelease.contentHash)).toEqual(
      release,
    );
  });

  it("persists structured observations after more than 1,000 earlier session events", async () => {
    const { store, workspace, release } = await fixture();
    const session = SessionSchema.parse({
      id: "session-observer",
      experience: "development",
      provider: "openpond",
      title: "Observer fixture",
      appId: null,
      appName: null,
      cwd: null,
      codexThreadId: null,
      createdAt: NOW,
      updatedAt: NOW,
      status: "active",
      pinned: false,
      archived: false,
      order: 0,
    });
    const turn = TurnSchema.parse({
      id: "turn-observer",
      sessionId: session.id,
      providerTurnId: null,
      prompt: "Create a DOCX report.",
      startedAt: NOW,
      completedAt: null,
      status: "in_progress",
      error: null,
      harnessSnapshot: {
        schemaVersion: "openpond.harnessTurnSnapshot.v1",
        workspaceId: workspace.id,
        workspaceRevision: workspace.revision,
        sourceRevision: workspace.sourceRevision,
        channelName: workspace.currentChannel.name,
        channelRevision: workspace.currentChannel.revision,
        harnessRelease: {
          id: release.harnessRelease.id,
          contentHash: release.harnessRelease.contentHash,
        },
      },
    });
    await Promise.all(
      Array.from({ length: 1_001 }, (_, index) =>
        store.appendRuntimeEvent({
          id: `earlier-reasoning-${index}`,
          sessionId: session.id,
          turnId: "earlier-turn",
          name: "assistant.reasoning.delta",
          timestamp: NOW,
          source: "provider",
          status: "completed",
          output: `Earlier reasoning ${index}`,
        }),
      ),
    );
    await store.appendRuntimeEvent({
      id: "tool-failed",
      sessionId: session.id,
      turnId: turn.id,
      name: "tool.completed",
      timestamp: NOW,
      source: "provider",
      action: "exec_command",
      status: "failed",
      output: "ModuleNotFoundError: No module named 'docx'",
      error: "ModuleNotFoundError: No module named 'docx'",
      data: { toolCallId: "call-one" },
    });

    expect(await store.getHarnessBackgroundReviewSettings(workspace.id)).toEqual({
      enabled: true,
      updatedAt: null,
    });
    await store.setHarnessBackgroundReviewSettings({
      workspaceId: workspace.id,
      enabled: false,
      updatedAt: NOW,
    });
    expect(await recordLocalHarnessImprovementBoundary({
      store,
      session,
      turn,
      boundaryKind: "completed_tool_batch",
      now: () => NOW,
    })).toBeNull();
    expect(
      await store.listHarnessImprovementArtifacts(workspace.id, "observation"),
    ).toEqual([]);
    await store.setHarnessBackgroundReviewSettings({
      workspaceId: workspace.id,
      enabled: true,
      updatedAt: LATER,
    });

    const openDetection = await recordLocalHarnessImprovementBoundary({
      store,
      session,
      turn,
      boundaryKind: "completed_tool_batch",
      now: () => NOW,
    });
    expect(openDetection?.observations).toHaveLength(1);
    expect(openDetection?.observations[0]).toMatchObject({
      kind: "tool_failure",
      state: "open",
    });
    expect(openDetection?.trigger.decision).toBe("no_action");

    await store.appendRuntimeEvent({
      id: "tool-recovered",
      sessionId: session.id,
      turnId: turn.id,
      name: "tool.completed",
      timestamp: LATER,
      source: "provider",
      action: "exec_command",
      status: "completed",
      output: "Created report.docx with the bundled document runtime.",
      data: { toolCallId: "call-two" },
    });

    const detection = await recordLocalHarnessImprovementBoundary({
      store,
      session,
      turn,
      boundaryKind: "completed_tool_batch",
      now: () => LATER,
    });
    expect(detection?.trigger).toMatchObject({
      decision: "queue_refiner",
      deterministicRoute: null,
    });
    expect(
      await store.listHarnessImprovementArtifacts(workspace.id, "observation"),
    ).toHaveLength(4);
    const triggers = await store.listHarnessImprovementArtifacts(
      workspace.id,
      "trigger_decision",
    );
    expect(triggers).toHaveLength(2);
    expect(triggers[0]).toMatchObject({
      schemaVersion: "openpond.refinementTriggerDecision.v1",
      turnId: turn.id,
    });
  });

  it("persists a revisioned run overlay with CAS, freeze, restore, and abandon", async () => {
    const { store, workspace, release } = await fixture();
    const overlay = createHarnessRunOverlay({
      schemaVersion: "openpond.harnessRunOverlay.v1",
      id: "overlay-durable-run",
      runId: "durable-run",
      baseHarnessRelease: {
        id: release.harnessRelease.id,
        contentHash: release.harnessRelease.contentHash,
      },
      workspace: {
        workspaceId: workspace.id,
        revision: workspace.revision,
        sourceRevision: workspace.sourceRevision,
        channelRevision: workspace.currentChannel.revision,
      },
      revision: 0,
      status: "active",
      edits: [],
      createdAt: NOW,
      updatedAt: NOW,
      metadata: {},
    });
    await store.createHarnessRunOverlay(overlay);
    expect(await store.getHarnessRunOverlay(overlay.runId)).toEqual(overlay);

    const note = "Use the bundled document runtime before importing python-docx.\n";
    const edit = HarnessOverlayEditSchema.parse({
      id: "overlay-edit-one",
      route: "prompt",
      operation: "create",
      target: "instructions/docx-runtime.md",
      summary: "Prefer the bundled DOCX runtime.",
      content: note,
      contentHash: contentHash(note),
      effects: ["text_instruction", "dependency_selection"],
    });
    const edited = await store.appendHarnessRunOverlayEditsAtomically({
      runId: overlay.runId,
      expectedRevision: 0,
      edits: [edit],
      updatedAt: LATER,
    });
    expect(edited).toMatchObject({ revision: 1, status: "active", edits: [edit] });
    await expect(
      store.appendHarnessRunOverlayEditsAtomically({
        runId: overlay.runId,
        expectedRevision: 0,
        edits: [],
        updatedAt: LATER,
      }),
    ).rejects.toThrow(/revision conflict/i);

    const frozen = await store.freezeHarnessRunOverlayAtomically({
      runId: overlay.runId,
      expectedRevision: 1,
      updatedAt: LATER,
    });
    expect(frozen).toMatchObject({ revision: 2, status: "frozen" });
    const restored = await store.restoreHarnessRunOverlayAtomically({
      runId: overlay.runId,
      expectedRevision: 2,
      restoreRevision: 0,
      updatedAt: LATER,
    });
    expect(restored).toMatchObject({
      revision: 3,
      status: "active",
      edits: [],
      metadata: { restoredFromRevision: 0 },
    });
    const abandoned = await store.abandonHarnessRunOverlayAtomically({
      runId: overlay.runId,
      expectedRevision: 3,
      updatedAt: LATER,
    });
    expect(abandoned).toMatchObject({ revision: 4, status: "abandoned" });
    await expect(
      store.appendHarnessRunOverlayEditsAtomically({
        runId: overlay.runId,
        expectedRevision: 4,
        edits: [edit],
        updatedAt: LATER,
      }),
    ).rejects.toThrow(/abandoned/i);
    expect(
      await store.listHarnessImprovementArtifacts(workspace.id, "run_overlay"),
    ).toHaveLength(5);
  });

  it("keeps a durable Agent run on H-before after its validated fix advances Personal current", async () => {
    const { directory, store, workspace, release: base } = await fixture();
    const runOverlay = await ensureLocalHarnessRunOverlay({
      store,
      runId: "durable-docx-run",
      workspace,
      harnessRelease: {
        id: base.harnessRelease.id,
        contentHash: base.harnessRelease.contentHash,
      },
      admittedAt: NOW,
    });
    const instruction = "# Personal Harness\n\nUse the bundled document runtime before DOCX generation.\n";
    const edit = HarnessOverlayEditSchema.parse({
      id: "durable-docx-edit",
      route: "skill",
      operation: "update",
      target: "instructions/system.md",
      summary: "Prefer the bundled document runtime.",
      content: instruction,
      contentHash: contentHash(instruction),
      effects: ["text_instruction", "dependency_selection"],
    });
    const edited = await store.appendHarnessRunOverlayEditsAtomically({
      runId: runOverlay.runId,
      expectedRevision: 0,
      edits: [edit],
      updatedAt: LATER,
    });
    const frozen = await store.freezeHarnessRunOverlayAtomically({
      runId: runOverlay.runId,
      expectedRevision: edited.revision,
      updatedAt: LATER,
    });
    const proposal = createHarnessImprovementProposal({
      schemaVersion: "openpond.harnessImprovementProposal.v1",
      id: "durable-docx-proposal",
      overlay: {
        id: frozen.id,
        revision: frozen.revision,
        contentHash: frozen.contentHash,
      },
      baseHarnessRelease: frozen.baseHarnessRelease,
      expectedWorkspace: frozen.workspace,
      requestedScope: "personal",
      route: "skill",
      risk: "low",
      effects: edit.effects,
      evidence: [
        {
          kind: "recovery",
          id: "durable-docx-recovery",
          contentHash: contentHash("recovered"),
        },
      ],
      edits: [edit],
      validationPlan: [
        {
          id: "durable-docx-skill-check",
          kind: "skill",
          description: "Validate the edited textual Harness instruction.",
          required: true,
        },
      ],
      expectedOutcome: "The next independent Agent run avoids the DOCX dependency detour.",
      createdAt: LATER,
      metadata: {},
    });
    const validation = createHarnessTargetedValidationReceipt({
      schemaVersion: "openpond.harnessTargetedValidationReceipt.v1",
      id: "durable-docx-validation",
      proposal: { id: proposal.id, contentHash: proposal.contentHash },
      validationId: "durable-docx-skill-check",
      kind: "skill",
      status: "passed",
      summary: "The edited instruction compiled into a valid Harness release.",
      evidenceRefs: [
        {
          kind: "validation",
          id: "durable-docx-validation-event",
          contentHash: contentHash("passed"),
        },
      ],
      createdAt: LATER,
      metadata: {},
    });
    const advanced = await applyLocalHarnessRefinerProposal({
      store,
      storeDir: directory,
      overlay: frozen,
      proposal,
      validations: [validation],
      receiptId: "durable-docx-advance",
      now: () => LATER,
    });
    expect(advanced.receipt.decision).toBe("advanced");

    const current = await loadSelectedLocalHarnessRuntime(store);
    const durable = await loadLocalHarnessRuntimeForAgentRun(
      store,
      runOverlay.runId,
    );
    expect(current?.release.harnessRelease.contentHash).not.toBe(
      base.harnessRelease.contentHash,
    );
    expect(durable?.release.harnessRelease.contentHash).toBe(
      base.harnessRelease.contentHash,
    );
  });

  it("records a source revision, persists Refiner evidence, and advances the channel atomically", async () => {
    const { directory, store, workspace: initial, release: base } = await fixture();
    const admittedBeforeAdvance = await loadSelectedLocalHarnessRuntime(store);
    const paths = localHarnessWorkspacePaths(directory, initial.id);
    const instructionPath = path.join(paths.source, "instructions", "system.md");
    const instruction = "# Personal Harness\n\nUse the bundled document runtime before DOCX generation.\n";
    await fs.writeFile(instructionPath, instruction);

    const candidate = await compileAndRegisterLocalHarnessRelease({
      store,
      storeDir: directory,
      workspaceId: initial.id,
      now: () => LATER,
    });
    expect(candidate.workspace.dirty).toBe(true);
    expect(candidate.workspace.revision).toBe(initial.revision + 1);
    expect(candidate.workspace.currentChannel.release).toEqual(initial.currentChannel.release);

    const edit = HarnessOverlayEditSchema.parse({
      id: "docx-dependency-edit",
      route: "skill",
      operation: "update",
      target: "instructions/system.md",
      summary: "Select the bundled document runtime before generating DOCX.",
      content: instruction,
      contentHash: contentHash(instruction),
      effects: ["text_instruction", "dependency_selection"],
    });
    const overlay = createHarnessRunOverlay({
      schemaVersion: "openpond.harnessRunOverlay.v1",
      id: "overlay-docx",
      runId: "work-docx",
      baseHarnessRelease: {
        id: base.harnessRelease.id,
        contentHash: base.harnessRelease.contentHash,
      },
      workspace: {
        workspaceId: candidate.workspace.id,
        revision: candidate.workspace.revision,
        sourceRevision: candidate.workspace.sourceRevision,
        channelRevision: candidate.workspace.currentChannel.revision,
      },
      revision: 1,
      status: "frozen",
      edits: [edit],
      createdAt: LATER,
      updatedAt: LATER,
      metadata: {},
    });
    const proposal = createHarnessImprovementProposal({
      schemaVersion: "openpond.harnessImprovementProposal.v1",
      id: "proposal-docx",
      overlay: { id: overlay.id, revision: overlay.revision, contentHash: overlay.contentHash },
      baseHarnessRelease: overlay.baseHarnessRelease,
      expectedWorkspace: overlay.workspace,
      requestedScope: "personal",
      route: "skill",
      risk: "low",
      effects: edit.effects,
      evidence: [{ kind: "recovery", id: "missing-docx-module", contentHash: contentHash("recovered") }],
      edits: [edit],
      validationPlan: [{
        id: "render-docx",
        kind: "file_render",
        description: "Generate and render a bounded DOCX fixture.",
        required: true,
      }],
      expectedOutcome: "The next Work avoids the missing document dependency detour.",
      createdAt: LATER,
      metadata: {},
    });
    const validation = createHarnessTargetedValidationReceipt({
      schemaVersion: "openpond.harnessTargetedValidationReceipt.v1",
      id: "validation-docx",
      proposal: { id: proposal.id, contentHash: proposal.contentHash },
      validationId: "render-docx",
      kind: "file_render",
      status: "passed",
      summary: "The DOCX fixture generated and rendered.",
      evidenceRefs: [{ kind: "validation", id: "rendered-docx", contentHash: contentHash("rendered") }],
      createdAt: LATER,
      metadata: {},
    });
    await store.saveHarnessImprovementArtifact(initial.id, "run_overlay", overlay);
    await store.saveHarnessImprovementArtifact(initial.id, "proposal", proposal);
    await store.saveHarnessImprovementArtifact(initial.id, "targeted_validation", validation);

    const advanced = await store.advanceHarnessWorkspaceAtomically({
      receiptId: "advance-docx",
      workspaceId: initial.id,
      proposal,
      validations: [validation],
      nextRelease: {
        id: candidate.release.harnessRelease.id,
        contentHash: candidate.release.harnessRelease.contentHash,
      },
      nextSourceRevision: candidate.release.sourceRevision,
      now: LATER,
    });
    expect(advanced.receipt.decision).toBe("advanced");
    expect(advanced.workspace.dirty).toBe(false);
    expect(advanced.workspace.currentChannel.release?.contentHash).toBe(
      candidate.release.harnessRelease.contentHash,
    );
    expect(base.harnessRelease.contentHash).not.toBe(candidate.release.harnessRelease.contentHash);
    const admittedAfterAdvance = await loadSelectedLocalHarnessRuntime(store);
    expect(admittedBeforeAdvance?.release.harnessRelease.contentHash).toBe(base.harnessRelease.contentHash);
    expect(admittedAfterAdvance?.release.harnessRelease.contentHash).toBe(
      candidate.release.harnessRelease.contentHash,
    );

    const retried = await store.advanceHarnessWorkspaceAtomically({
      receiptId: "advance-docx",
      workspaceId: initial.id,
      proposal,
      validations: [validation],
      nextRelease: {
        id: candidate.release.harnessRelease.id,
        contentHash: candidate.release.harnessRelease.contentHash,
      },
      nextSourceRevision: candidate.release.sourceRevision,
      now: LATER,
    });
    expect(retried.receipt).toEqual(advanced.receipt);
    expect(retried.workspace.revision).toBe(advanced.workspace.revision);
    expect(await store.listHarnessAdvanceReceipts(initial.id)).toHaveLength(1);
  });

  it("rejects undeclared source files and detects tampering in an existing release bundle", async () => {
    const { directory, workspace, release } = await fixture();
    const paths = localHarnessWorkspacePaths(directory, workspace.id);
    await fs.writeFile(path.join(paths.source, "undeclared.txt"), "not declared\n");
    await expect(
      compileLocalHarnessSource({ workspaceId: workspace.id, sourceDir: paths.source }),
    ).rejects.toThrow("Unlisted: undeclared.txt");
    await fs.rm(path.join(paths.source, "undeclared.txt"));

    await fs.writeFile(path.join(release.bundlePath, "source", "instructions", "system.md"), "tampered\n");
    const compiled = await compileLocalHarnessSource({
      workspaceId: workspace.id,
      sourceDir: paths.source,
    });
    await expect(
      materializeLocalHarnessRelease({
        storeDir: directory,
        workspaceId: workspace.id,
        compiled,
        createdAt: LATER,
      }),
    ).rejects.toThrow("failed hash verification");
  });

  it("imports selected Profile Skills and Agents once, excludes evals, and supports workspace selection", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openpond-harness-import-"));
    const store = new SqliteStore(directory);
    cleanup.push({ directory, store });
    const repoPath = path.join(directory, "profile-repo");
    const sourcePath = path.join(repoPath, "profiles", "personal");
    await fs.mkdir(path.join(sourcePath, "skills", "documents"), { recursive: true });
    await fs.mkdir(path.join(sourcePath, "agent"), { recursive: true });
    await fs.writeFile(
      path.join(sourcePath, "skills", "documents", "SKILL.md"),
      "---\nname: documents\ndescription: Create documents.\n---\n\nUse the document runtime.\n",
    );
    await fs.writeFile(path.join(sourcePath, "skills", "documents", "reference.md"), "Reference.\n");
    await fs.writeFile(path.join(sourcePath, "agent", "agent.ts"), "export const agent = {};\n");
    await fs.writeFile(path.join(repoPath, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const empty = emptyOpenPondProfileState();
    const profile = {
      ...empty,
      mode: "local" as const,
      repoPath,
      activeProfile: "personal",
      sourcePath,
      agents: [{ id: "default", name: "Default", path: "agent/agent.ts", enabled: true }],
      skills: [{
        name: "documents",
        description: "Create documents.",
        path: "skills/documents/SKILL.md",
        scope: "profile" as const,
        enabled: true,
        sourcePath,
        charCount: 80,
        sourceHash: contentHash("skill"),
        validationStatus: "valid" as const,
        validationMessages: [],
        resourceFiles: ["reference.md"],
      }],
      evals: [{
        id: "legacy-eval",
        name: "Legacy eval",
        path: "evals/legacy.ts",
        agentId: null,
        sourcePath,
      }],
      git: {
        isRepo: true,
        branch: "main",
        head: "abc123",
        shortHead: "abc123",
        dirty: false,
        upstream: null,
        ahead: null,
        behind: null,
        remoteUrl: null,
        files: [],
        error: null,
      },
    };

    const imported = await importProfileIntoLocalHarnessWorkspace({
      store,
      storeDir: directory,
      id: "imported-personal",
      ownerId: "desktop-personal",
      name: "Imported Personal Harness",
      profile,
      now: () => NOW,
    });
    expect(imported.release.agentSnapshot.skills).toHaveLength(1);
    expect(imported.release.agentSnapshot.agents).toHaveLength(1);
    expect(imported.release.harnessRelease.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "instructions/system.md",
        }),
      ]),
    );
    expect(imported.release.harnessRelease.files.some((file) => file.path.includes("legacy"))).toBe(false);
    expect(imported.release.harnessRelease.metadata).toMatchObject({
      sourceLayout: "openpond.harnessSourceManifest.v1",
    });

    await store.selectHarnessWorkspace({
      ownerKind: "personal",
      ownerId: "desktop-personal",
      workspaceId: imported.workspace.id,
      updatedAt: NOW,
    });
    expect(
      await store.getSelectedHarnessWorkspace({ ownerKind: "personal", ownerId: "desktop-personal" }),
    ).toEqual(imported.workspace);
    const skillRuntime = await loadSelectedLocalHarnessSkillRuntime(store);
    expect(skillRuntime?.skills.map((skill) => skill.name)).toEqual(["documents"]);
    await expect(skillRuntime?.readSkill?.("documents")).resolves.toMatchObject({
      name: "documents",
      description: "Create documents.",
      body: "Use the document runtime.",
      resourceFiles: ["reference.md"],
    });

    const admittedBeforeRefine = await loadSelectedLocalHarnessRuntime(store);
    expect(admittedBeforeRefine?.instructionContext).toContain("Active Harness preflight:");
    expect(admittedBeforeRefine?.instructionContext).toContain("Harness capability receipt:");
    expect(admittedBeforeRefine?.instructionContext).not.toContain("Use the document runtime.");
    expect(admittedBeforeRefine?.instructionContext).not.toContain("export const agent = {};");
    const improvedSkill = "---\nname: documents\ndescription: Create documents.\n---\n\nUse the bundled document runtime before importing DOCX libraries.\n";
    const edit = HarnessOverlayEditSchema.parse({
      id: "improve-documents-skill",
      route: "skill",
      operation: "update",
      target: "skills/documents/SKILL.md",
      summary: "Avoid the missing DOCX dependency detour.",
      content: improvedSkill,
      contentHash: contentHash(improvedSkill),
      effects: ["text_instruction", "dependency_selection"],
    });
    const overlay = createHarnessRunOverlay({
      schemaVersion: "openpond.harnessRunOverlay.v1",
      id: "profile-import-overlay",
      runId: "work-docx-import",
      baseHarnessRelease: {
        id: imported.release.harnessRelease.id,
        contentHash: imported.release.harnessRelease.contentHash,
      },
      workspace: {
        workspaceId: imported.workspace.id,
        revision: imported.workspace.revision,
        sourceRevision: imported.workspace.sourceRevision,
        channelRevision: imported.workspace.currentChannel.revision,
      },
      revision: 1,
      status: "frozen",
      edits: [edit],
      createdAt: LATER,
      updatedAt: LATER,
      metadata: {},
    });
    const proposal = createHarnessImprovementProposal({
      schemaVersion: "openpond.harnessImprovementProposal.v1",
      id: "profile-import-proposal",
      overlay: { id: overlay.id, revision: overlay.revision, contentHash: overlay.contentHash },
      baseHarnessRelease: overlay.baseHarnessRelease,
      expectedWorkspace: overlay.workspace,
      requestedScope: "personal",
      route: "skill",
      risk: "low",
      effects: edit.effects,
      evidence: [{ kind: "recovery", id: "docx-recovery", contentHash: contentHash("recovery") }],
      edits: [edit],
      validationPlan: [{
        id: "validate-skill",
        kind: "skill",
        description: "Parse and load the updated released Skill.",
        required: true,
      }],
      expectedOutcome: "Future document Work loads the dependency guidance before execution.",
      createdAt: LATER,
      metadata: {},
    });
    const validation = createHarnessTargetedValidationReceipt({
      schemaVersion: "openpond.harnessTargetedValidationReceipt.v1",
      id: "profile-import-validation",
      proposal: { id: proposal.id, contentHash: proposal.contentHash },
      validationId: "validate-skill",
      kind: "skill",
      status: "passed",
      summary: "The updated Skill parses and loads.",
      evidenceRefs: [{ kind: "validation", id: "skill-parse", contentHash: contentHash("passed") }],
      createdAt: LATER,
      metadata: {},
    });
    const advanced = await applyLocalHarnessRefinerProposal({
      store,
      storeDir: directory,
      overlay,
      proposal,
      validations: [validation],
      receiptId: "profile-import-advance",
      now: () => LATER,
    });
    expect(advanced.receipt.decision).toBe("advanced");
    const admittedAfterRefine = await loadSelectedLocalHarnessRuntime(store);
    expect(admittedBeforeRefine?.release.harnessRelease.contentHash).not.toBe(
      admittedAfterRefine?.release.harnessRelease.contentHash,
    );
    await expect(admittedBeforeRefine?.skillRuntime.readSkill?.("documents")).resolves.toMatchObject({
      body: "Use the document runtime.",
    });
    await expect(admittedAfterRefine?.skillRuntime.readSkill?.("documents")).resolves.toMatchObject({
      body: "Use the bundled document runtime before importing DOCX libraries.",
    });
  });
});
