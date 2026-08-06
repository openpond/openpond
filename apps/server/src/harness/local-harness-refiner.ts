import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  HarnessImprovementProposalSchema,
  HarnessRunOverlaySchema,
  HarnessTargetedValidationReceiptSchema,
  classifyHarnessAutoAdvanceAuthority,
  type HarnessAdvanceReceipt,
  type HarnessImprovementProposal,
  type HarnessRunOverlay,
  type HarnessTargetedValidationReceipt,
  type HarnessWorkspace,
} from "@openpond/contracts";

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

async function applyOverlayEdits(
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
