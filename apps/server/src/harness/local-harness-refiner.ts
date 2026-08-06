import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  HarnessImprovementProposalSchema,
  HarnessRunOverlaySchema,
  HarnessTargetedValidationReceiptSchema,
  classifyHarnessAutoAdvanceAuthority,
  createHarnessTargetedValidationReceipt,
  type HarnessAdvanceReceipt,
  type HarnessImprovementProposal,
  type HarnessRunOverlay,
  type HarnessTargetedValidationReceipt,
  type HarnessWorkspace,
} from "@openpond/contracts";
import { parseProfileSkillMarkdown } from "@openpond/cloud";

import type { SqliteStore } from "../store/store.js";
import {
  compileLocalHarnessSource,
  localHarnessWorkspacePaths,
  materializeLocalHarnessRelease,
} from "./local-harness-workspace-service.js";

export async function applyLocalHarnessRefinerProposal(input: {
  store: SqliteStore;
  storeDir: string;
  overlay: HarnessRunOverlay;
  proposal: HarnessImprovementProposal;
  validations: HarnessTargetedValidationReceipt[];
  receiptId: string;
  now?: () => string;
}): Promise<{ workspace: HarnessWorkspace; receipt: HarnessAdvanceReceipt }> {
  const overlay = HarnessRunOverlaySchema.parse(input.overlay);
  const proposal = HarnessImprovementProposalSchema.parse(input.proposal);
  const validations = input.validations.map((receipt) =>
    HarnessTargetedValidationReceiptSchema.parse(receipt),
  );
  if (
    proposal.overlay.id !== overlay.id ||
    proposal.overlay.revision !== overlay.revision ||
    proposal.overlay.contentHash !== overlay.contentHash
  ) {
    throw new Error("Refiner proposal is not bound to the supplied run overlay.");
  }
  if (overlay.status !== "frozen") throw new Error("Only a frozen run overlay can advance a Harness workspace.");
  const workspace = await input.store.getHarnessWorkspace(proposal.expectedWorkspace.workspaceId);
  if (!workspace) throw new Error(`Harness workspace ${proposal.expectedWorkspace.workspaceId} does not exist.`);
  if (workspace.location !== "local") throw new Error("The local Refiner can only advance a local Harness workspace.");

  const paths = localHarnessWorkspacePaths(input.storeDir, workspace.id);
  const current = await compileLocalHarnessSource({
    workspaceId: workspace.id,
    sourceDir: paths.source,
  });
  if (current.sourceRevision !== workspace.sourceRevision) {
    throw new Error(
      `Harness source is ${current.sourceRevision}; workspace expects ${workspace.sourceRevision}. Record or revert the source change before refinement.`,
    );
  }
  const candidateSource = path.join(paths.root, `.source-candidate-${randomUUID()}`);
  await fs.cp(paths.source, candidateSource, {
    recursive: true,
    force: false,
    errorOnExist: true,
    verbatimSymlinks: false,
  });
  try {
    await applyOverlayEdits(candidateSource, proposal);
    const compiled = await compileLocalHarnessSource({
      workspaceId: workspace.id,
      sourceDir: candidateSource,
    });
    const timestamp = (input.now ?? (() => new Date().toISOString()))();
    const release = await materializeLocalHarnessRelease({
      storeDir: input.storeDir,
      workspaceId: workspace.id,
      compiled,
      createdAt: timestamp,
    });
    await input.store.saveHarnessReleaseRecord(release);
    await input.store.saveHarnessImprovementArtifact(workspace.id, "run_overlay", overlay);
    await input.store.saveHarnessImprovementArtifact(workspace.id, "proposal", proposal);
    for (const validation of validations) {
      await input.store.saveHarnessImprovementArtifact(
        workspace.id,
        "targeted_validation",
        validation,
      );
    }

    const authority = classifyHarnessAutoAdvanceAuthority({ workspace, proposal });
    if (!authority.eligible) {
      return input.store.advanceHarnessWorkspaceAtomically({
        receiptId: input.receiptId,
        workspaceId: workspace.id,
        proposal,
        validations,
        nextRelease: {
          id: release.harnessRelease.id,
          contentHash: release.harnessRelease.contentHash,
        },
        nextSourceRevision: release.sourceRevision,
        now: timestamp,
      });
    }

    const backupSource = path.join(paths.root, `.source-backup-${randomUUID()}`);
    const journalPath = path.join(paths.root, "source-swap.json");
    await writeSwapJournal(journalPath, {
      schemaVersion: "openpond.localHarnessSourceSwap.v1",
      workspaceId: workspace.id,
      expectedWorkspaceRevision: workspace.revision,
      previousSourceRevision: workspace.sourceRevision,
      nextSourceRevision: release.sourceRevision,
      backupSource,
      candidateSource,
      createdAt: timestamp,
    });
    await fs.rename(paths.source, backupSource);
    await fs.rename(candidateSource, paths.source);
    try {
      const result = await input.store.advanceHarnessWorkspaceAtomically({
        receiptId: input.receiptId,
        workspaceId: workspace.id,
        proposal,
        validations,
        nextRelease: {
          id: release.harnessRelease.id,
          contentHash: release.harnessRelease.contentHash,
        },
        nextSourceRevision: release.sourceRevision,
        now: timestamp,
      });
      if (result.receipt.decision !== "advanced") {
        await restoreSource(paths.source, backupSource);
      } else {
        await fs.rm(backupSource, { recursive: true, force: true });
      }
      await fs.rm(journalPath, { force: true });
      return result;
    } catch (error) {
      await restoreSource(paths.source, backupSource).catch(() => undefined);
      await fs.rm(journalPath, { force: true }).catch(() => undefined);
      throw error;
    }
  } finally {
    await fs.rm(candidateSource, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function rollbackLocalHarnessWorkspaceRelease(input: {
  store: SqliteStore;
  storeDir: string;
  workspaceId: string;
  targetRelease: { id: string; contentHash: string };
  rollbackOf: { id: string; contentHash: string };
  receiptId: string;
  now?: () => string;
}): Promise<{ workspace: HarnessWorkspace; receipt: HarnessAdvanceReceipt }> {
  const workspace = await input.store.getHarnessWorkspace(input.workspaceId);
  if (!workspace || workspace.location !== "local") {
    throw new Error(`Local Harness workspace ${input.workspaceId} does not exist.`);
  }
  if (
    workspace.currentChannel.release?.id !== input.rollbackOf.id ||
    workspace.currentChannel.release.contentHash !== input.rollbackOf.contentHash
  ) {
    throw new Error("Harness rollback source is no longer the current release.");
  }
  const target = await input.store.getHarnessReleaseRecord(input.targetRelease.contentHash);
  if (
    !target ||
    target.workspaceId !== workspace.id ||
    target.harnessRelease.id !== input.targetRelease.id
  ) {
    throw new Error("Harness rollback target is unavailable in this workspace.");
  }
  const paths = localHarnessWorkspacePaths(input.storeDir, workspace.id);
  const current = await compileLocalHarnessSource({
    workspaceId: workspace.id,
    sourceDir: paths.source,
  });
  if (current.sourceRevision !== workspace.sourceRevision) {
    throw new Error("Harness source changed before rollback.");
  }
  const candidateSource = path.join(paths.root, `.source-rollback-${randomUUID()}`);
  await fs.cp(path.join(target.bundlePath, "source"), candidateSource, {
    recursive: true,
    force: false,
    errorOnExist: true,
    verbatimSymlinks: false,
  });
  try {
    const candidate = await compileLocalHarnessSource({
      workspaceId: workspace.id,
      sourceDir: candidateSource,
    });
    if (candidate.sourceRevision !== target.sourceRevision) {
      throw new Error("Harness rollback bundle does not reproduce its registered source revision.");
    }
    const timestamp = (input.now ?? (() => new Date().toISOString()))();
    const backupSource = path.join(paths.root, `.source-backup-${randomUUID()}`);
    const journalPath = path.join(paths.root, "source-swap.json");
    await writeSwapJournal(journalPath, {
      schemaVersion: "openpond.localHarnessSourceSwap.v1",
      workspaceId: workspace.id,
      expectedWorkspaceRevision: workspace.revision,
      previousSourceRevision: workspace.sourceRevision,
      nextSourceRevision: target.sourceRevision,
      backupSource,
      candidateSource,
      createdAt: timestamp,
    });
    await fs.rename(paths.source, backupSource);
    await fs.rename(candidateSource, paths.source);
    try {
      const result = await input.store.rollbackHarnessWorkspaceAtomically({
        receiptId: input.receiptId,
        workspaceId: workspace.id,
        expectedWorkspaceRevision: workspace.revision,
        expectedChannelRevision: workspace.currentChannel.revision,
        targetRelease: input.targetRelease,
        targetSourceRevision: target.sourceRevision,
        rollbackOf: input.rollbackOf,
        now: timestamp,
      });
      if (result.receipt.decision !== "rolled_back") {
        await restoreSource(paths.source, backupSource);
      } else {
        await fs.rm(backupSource, { recursive: true, force: true });
      }
      await fs.rm(journalPath, { force: true });
      return result;
    } catch (error) {
      await restoreSource(paths.source, backupSource).catch(() => undefined);
      await fs.rm(journalPath, { force: true }).catch(() => undefined);
      throw error;
    }
  } finally {
    await fs.rm(candidateSource, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function validateLocalHarnessRefinerProposal(input: {
  storeDir: string;
  workspace: HarnessWorkspace;
  proposal: HarnessImprovementProposal;
  now?: () => string;
}): Promise<HarnessTargetedValidationReceipt[]> {
  const proposal = HarnessImprovementProposalSchema.parse(input.proposal);
  if (proposal.expectedWorkspace.workspaceId !== input.workspace.id) {
    throw new Error("Refiner proposal targets a different Harness workspace.");
  }
  const paths = localHarnessWorkspacePaths(input.storeDir, input.workspace.id);
  const candidateSource = path.join(paths.root, `.validation-candidate-${randomUUID()}`);
  await fs.cp(paths.source, candidateSource, {
    recursive: true,
    force: false,
    errorOnExist: true,
    verbatimSymlinks: false,
  });
  const timestamp = (input.now ?? (() => new Date().toISOString()))();
  try {
    await applyOverlayEdits(candidateSource, proposal);
    const compiled = await compileLocalHarnessSource({
      workspaceId: input.workspace.id,
      sourceDir: candidateSource,
    });
    const declarations = new Map(
      compiled.manifest.files.map((file) => [file.path, file] as const),
    );
    const editByTarget = new Map(proposal.edits.map((edit) => [edit.target, edit] as const));
    return Promise.all(proposal.validationPlan.map(async (plan) => {
      let status: HarnessTargetedValidationReceipt["status"] = "passed";
      let summary = "The candidate Harness source compiles and preserves its manifest contract.";
      try {
        if (plan.kind === "prompt") {
          const edits = proposal.edits.filter((edit) =>
            declarations.get(edit.target)?.kind === "instruction",
          );
          if (edits.length === 0) {
            throw new Error("Prompt validation requires an instruction-file edit.");
          }
          summary = `Validated ${edits.length} textual instruction edit(s) and compiled candidate ${compiled.harnessRelease.id}.`;
        } else if (plan.kind === "skill") {
          const edits = proposal.edits.filter((edit) =>
            declarations.get(edit.target)?.kind === "skill",
          );
          if (edits.length === 0) {
            throw new Error("Skill validation requires a declared Skill-file edit.");
          }
          for (const edit of edits) {
            const content = editByTarget.get(edit.target)?.content;
            if (!content) throw new Error(`Skill edit ${edit.target} has no content.`);
            const parsed = parseProfileSkillMarkdown(content);
            if (!parsed.name || !parsed.description || parsed.messages.length > 0) {
              throw new Error(`Skill ${edit.target} is invalid: ${parsed.messages.join(" ")}`);
            }
          }
          summary = `Validated ${edits.length} Skill edit(s), Skill frontmatter, and compiled candidate ${compiled.harnessRelease.id}.`;
        } else if (plan.kind === "dependency" || plan.kind === "package") {
          const dependency = compiled.manifest.files.find(
            (file) => file.kind === "dependency_lock",
          );
          if (!dependency) throw new Error("Candidate Harness has no dependency lock.");
          JSON.parse(
            await fs.readFile(containedPath(candidateSource, dependency.path), "utf8"),
          );
          summary = `Validated dependency lock ${dependency.path} and compiled candidate ${compiled.harnessRelease.id}.`;
        } else {
          status = "blocked";
          summary = `Local targeted validation does not yet own ${plan.kind}; it requires its dedicated validator.`;
        }
      } catch (error) {
        status = "failed";
        summary = error instanceof Error ? error.message : String(error);
      }
      return createHarnessTargetedValidationReceipt({
        schemaVersion: "openpond.harnessTargetedValidationReceipt.v1",
        id: `validation-${proposal.id}-${plan.id}`,
        proposal: { id: proposal.id, contentHash: proposal.contentHash },
        validationId: plan.id,
        kind: plan.kind,
        status,
        summary,
        evidenceRefs: proposal.evidence,
        createdAt: timestamp,
        metadata: {
          candidateHarnessRelease: {
            id: compiled.harnessRelease.id,
            contentHash: compiled.harnessRelease.contentHash,
          },
          sourceRevision: compiled.sourceRevision,
        },
      });
    }));
  } catch (error) {
    const summary = error instanceof Error ? error.message : String(error);
    return proposal.validationPlan.map((plan) =>
      createHarnessTargetedValidationReceipt({
        schemaVersion: "openpond.harnessTargetedValidationReceipt.v1",
        id: `validation-${proposal.id}-${plan.id}`,
        proposal: { id: proposal.id, contentHash: proposal.contentHash },
        validationId: plan.id,
        kind: plan.kind,
        status: "failed",
        summary,
        evidenceRefs: proposal.evidence,
        createdAt: timestamp,
        metadata: {},
      }),
    );
  } finally {
    await fs.rm(candidateSource, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function recoverLocalHarnessSourceSwap(input: {
  store: SqliteStore;
  storeDir: string;
  workspaceId: string;
}): Promise<"none" | "completed" | "restored"> {
  const workspace = await input.store.getHarnessWorkspace(input.workspaceId);
  if (!workspace) throw new Error(`Harness workspace ${input.workspaceId} does not exist.`);
  const paths = localHarnessWorkspacePaths(input.storeDir, workspace.id);
  const journalPath = path.join(paths.root, "source-swap.json");
  const journal = await fs.readFile(journalPath, "utf8").then(JSON.parse).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }) as null | {
    nextSourceRevision: string;
    previousSourceRevision: string;
    backupSource: string;
  };
  if (!journal) return "none";
  const current = await compileLocalHarnessSource({ workspaceId: workspace.id, sourceDir: paths.source });
  if (
    workspace.sourceRevision === journal.nextSourceRevision &&
    current.sourceRevision === journal.nextSourceRevision
  ) {
    await fs.rm(journal.backupSource, { recursive: true, force: true });
    await fs.rm(journalPath, { force: true });
    return "completed";
  }
  const backup = await compileLocalHarnessSource({
    workspaceId: workspace.id,
    sourceDir: journal.backupSource,
  });
  if (
    workspace.sourceRevision === journal.previousSourceRevision &&
    backup.sourceRevision === journal.previousSourceRevision
  ) {
    await restoreSource(paths.source, journal.backupSource);
    await fs.rm(journalPath, { force: true });
    return "restored";
  }
  throw new Error("Harness source-swap recovery cannot reconcile filesystem and workspace revisions.");
}

export async function applyOverlayEdits(
  sourceRoot: string,
  proposal: HarnessImprovementProposal,
): Promise<void> {
  for (const edit of proposal.edits) {
    const target = containedPath(sourceRoot, edit.target);
    if (edit.operation === "delete") {
      await fs.rm(target, { force: false });
      continue;
    }
    if (edit.content === null) throw new Error(`Refiner edit ${edit.id} has no content.`);
    if (edit.operation === "create") {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, edit.content, { flag: "wx" });
    } else {
      const stats = await fs.lstat(target);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new Error(`Refiner update target must be a regular file: ${edit.target}`);
      }
      await fs.writeFile(target, edit.content, { flag: "w" });
    }
  }
}

function containedPath(root: string, relativePath: string): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...relativePath.replaceAll("\\", "/").split("/"));
  const relative = path.relative(resolvedRoot, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refiner edit target escapes the Harness source: ${relativePath}`);
  }
  return target;
}

async function writeSwapJournal(filePath: string, value: Record<string, unknown>): Promise<void> {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  await fs.rename(temporary, filePath);
}

async function restoreSource(activeSource: string, backupSource: string): Promise<void> {
  await fs.rm(activeSource, { recursive: true, force: true });
  await fs.rename(backupSource, activeSource);
}
