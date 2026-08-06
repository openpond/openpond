import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
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
import { contentHash } from "@openpond/harness";

import type { SqliteStore } from "../store/store.js";
import {
  compileLocalHarnessSource,
  localHarnessWorkspacePaths,
  materializeLocalHarnessRelease,
  type CompiledLocalHarnessSource,
} from "./local-harness-workspace-service.js";

export async function applyLocalHarnessRefinerProposal(input: {
  store: SqliteStore;
  storeDir: string;
  overlay: HarnessRunOverlay;
  proposal: HarnessImprovementProposal;
  validations: HarnessTargetedValidationReceipt[];
  receiptId: string;
  reviewAuthority?: { reviewer: string } | null;
  now?: () => string;
}): Promise<{ workspace: HarnessWorkspace; receipt: HarnessAdvanceReceipt }> {
  const overlay = HarnessRunOverlaySchema.parse(input.overlay);
  const proposal = HarnessImprovementProposalSchema.parse(input.proposal);
  const validations = input.validations.map((receipt) =>
    HarnessTargetedValidationReceiptSchema.parse(receipt),
  );
  const behavioralAgentEdits = proposal.route === "agent"
    ? proposal.edits.filter(
        (edit) => edit.target !== "harness.json" && edit.operation !== "delete",
      )
    : [];
  if (behavioralAgentEdits.length > 0) {
    const activationPlan = proposal.validationPlan.find(
      (plan) => plan.kind === "component_activation" && plan.required,
    );
    if (!activationPlan) {
      throw new Error(
        "Desktop Work Agent proposals require component-activation validation before review.",
      );
    }
    const activation = validations.find(
      (receipt) => receipt.validationId === activationPlan.id,
    );
    if (activation?.status === "passed") {
      throw new Error(
        "Desktop Work cannot accept a passed Agent activation receipt until an Agent source executor exists.",
      );
    }
  }
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
    if (!authority.eligible && !input.reviewAuthority) {
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
      const result = input.reviewAuthority
        ? await input.store.advanceReviewedHarnessWorkspaceAtomically({
            receiptId: input.receiptId,
            workspaceId: workspace.id,
            proposal,
            validations,
            nextRelease: {
              id: release.harnessRelease.id,
              contentHash: release.harnessRelease.contentHash,
            },
            nextSourceRevision: release.sourceRevision,
            reviewer: input.reviewAuthority.reviewer,
            now: timestamp,
          })
        : await input.store.advanceHarnessWorkspaceAtomically({
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
  if (proposal.route === "memory") {
    return validateMemoryProposal({ proposal, now: input.now });
  }
  const paths = localHarnessWorkspacePaths(input.storeDir, input.workspace.id);
  const beforeCompiled = await compileLocalHarnessSource({
    workspaceId: input.workspace.id,
    sourceDir: paths.source,
  });
  if (beforeCompiled.sourceRevision !== proposal.expectedWorkspace.sourceRevision) {
    throw new Error(
      "Refiner proposal source revision no longer matches the Local Harness workspace.",
    );
  }
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
    const beforeRuntimeSurface = desktopWorkRuntimeSurface(beforeCompiled);
    const candidateRuntimeSurface = desktopWorkRuntimeSurface(compiled);
    return Promise.all(proposal.validationPlan.map(async (plan) => {
      let status: HarnessTargetedValidationReceipt["status"] = "passed";
      let summary = "The candidate Harness source compiles and preserves its manifest contract.";
      try {
        if (plan.kind === "observed_recovery") {
          const recoveries = proposal.evidence.filter((evidence) => evidence.kind === "recovery");
          if (recoveries.length === 0) {
            throw new Error("Observed-recovery validation requires recorded recovery evidence.");
          }
          summary = `Validated ${recoveries.length} immutable recovery evidence reference(s) before candidate advancement.`;
        } else if (plan.kind === "prompt") {
          const edits = proposal.edits.filter((edit) =>
            edit.route === "prompt" && edit.target !== "harness.json",
          );
          if (edits.length === 0) {
            throw new Error("Prompt validation requires an instruction-file edit.");
          }
          for (const edit of edits) {
            const declaration = declarations.get(edit.target);
            if (edit.operation === "delete") {
              if (declaration) throw new Error(`Deleted instruction ${edit.target} remains declared.`);
            } else if (declaration?.kind !== "instruction") {
              throw new Error(`Instruction ${edit.target} is not declared in the candidate Harness.`);
            }
            if (edit.content !== null && /\b(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]/i.test(edit.content)) {
              throw new Error(`Instruction ${edit.target} appears to contain credential material.`);
            }
          }
          summary = `Validated ${edits.length} textual instruction edit(s) and compiled candidate ${compiled.harnessRelease.id}.`;
        } else if (plan.kind === "skill") {
          const edits = proposal.edits.filter((edit) =>
            edit.route === "skill" && edit.target !== "harness.json",
          );
          if (edits.length === 0) {
            throw new Error("Skill validation requires a declared Skill-file edit.");
          }
          for (const edit of edits) {
            const declaration = declarations.get(edit.target);
            if (edit.operation === "delete") {
              if (declaration) throw new Error(`Deleted Skill ${edit.target} remains declared.`);
              continue;
            }
            if (declaration?.kind !== "skill") {
              throw new Error(`Skill ${edit.target} is not declared in the candidate Harness.`);
            }
            const content = editByTarget.get(edit.target)?.content;
            if (!content) throw new Error(`Skill edit ${edit.target} has no content.`);
            const parsed = parseProfileSkillMarkdown(content);
            if (!parsed.name || !parsed.description || parsed.messages.length > 0) {
              throw new Error(`Skill ${edit.target} is invalid: ${parsed.messages.join(" ")}`);
            }
          }
          summary = `Validated ${edits.length} Skill edit(s), Skill frontmatter, and compiled candidate ${compiled.harnessRelease.id}.`;
        } else if (plan.kind === "dependency") {
          const dependency = compiled.manifest.files.find(
            (file) => file.kind === "dependency_lock",
          );
          if (!dependency) throw new Error("Candidate Harness has no dependency lock.");
          JSON.parse(
            await fs.readFile(containedPath(candidateSource, dependency.path), "utf8"),
          );
          summary = `Validated dependency lock ${dependency.path} and compiled candidate ${compiled.harnessRelease.id}.`;
        } else if (plan.kind === "schema") {
          HarnessImprovementProposalSchema.parse(proposal);
          summary = `Validated proposal, manifest, and candidate release schemas for ${compiled.harnessRelease.id}.`;
        } else if (plan.kind === "package") {
          const agentEdits = proposal.edits.filter((edit) =>
            edit.route === "agent" && edit.operation !== "delete" && edit.target !== "harness.json",
          );
          for (const edit of agentEdits) {
            if (!edit.content) throw new Error(`Agent edit ${edit.target} has no source.`);
            stripTypeScriptTypes(edit.content, {
              mode: "transform",
              sourceUrl: edit.target,
              sourceMap: false,
            });
          }
          summary = agentEdits.length > 0
            ? `Syntax-checked ${agentEdits.length} Agent source edit(s) and compiled candidate ${compiled.harnessRelease.id}.`
            : `Compiled candidate package ${compiled.harnessRelease.id} and preserved the Harness source manifest contract.`;
        } else if (plan.kind === "component_activation") {
          const componentEdits = proposal.edits.filter((edit) => edit.target !== "harness.json");
          if (componentEdits.length === 0) {
            throw new Error("Component activation requires a concrete Harness component edit.");
          }
          if (proposal.route === "agent") {
            const behavioralEdits = componentEdits.filter((edit) => edit.operation !== "delete");
            if (behavioralEdits.length > 0) {
              throw new Error(
                "Desktop Work does not compile or execute released Agent source; use an active instruction or standalone Skill, or add an Agent executor before release.",
              );
            }
            summary = `Confirmed ${componentEdits.length} deleted Agent component(s) were inactive in Desktop Work.`;
          } else {
            if (!["prompt", "skill"].includes(proposal.route)) {
              throw new Error(`Desktop Work has no activation policy for ${proposal.route} proposals.`);
            }
            const expectedKind = proposal.route === "prompt" ? "instruction" : "skill";
            for (const edit of componentEdits) {
              const active = candidateRuntimeSurface.components.find(
                (component) => component.path === edit.target && component.kind === expectedKind,
              );
              if (edit.operation === "delete" ? active : !active) {
                throw new Error(
                  `${expectedKind} ${edit.target} is not reflected in the candidate Desktop Work runtime surface.`,
                );
              }
            }
            if (beforeRuntimeSurface.contentHash === candidateRuntimeSurface.contentHash) {
              throw new Error("The candidate does not change the effective Desktop Work runtime surface.");
            }
            summary = `Activated ${componentEdits.length} ${expectedKind} edit(s) in the candidate Desktop Work runtime surface.`;
          }
        } else if (plan.kind === "business_formula") {
          status = "blocked";
          summary = "Business or financial logic is retained for review until an approved deterministic fixture supplies inputs and expected outputs.";
        } else if (plan.kind === "targeted_evaluation") {
          status = "blocked";
          summary = "This sensitive change requires an explicit authority-preserving targeted Evaluation before release.";
        } else if (plan.kind === "file_render") {
          status = "blocked";
          summary = "File-render validation requires an exact produced artifact reference; no artifact was attached to this Harness-source proposal.";
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
          ...(plan.kind === "component_activation"
            ? {
                targetRuntime: "desktop_work",
                beforeEffectiveRuntimeHash: beforeRuntimeSurface.contentHash,
                afterEffectiveRuntimeHash: candidateRuntimeSurface.contentHash,
                activatedComponentRefs: candidateRuntimeSurface.components,
                inactiveAgentRefs: candidateRuntimeSurface.inactiveAgents,
              }
            : {}),
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

function desktopWorkRuntimeSurface(
  compiled: CompiledLocalHarnessSource,
): {
  contentHash: string;
  components: Array<{
    kind: "instruction" | "skill";
    path: string;
    contentHash: string;
  }>;
  inactiveAgents: Array<{ path: string; contentHash: string }>;
} {
  const components = [
    ...compiled.agentSnapshot.instructions.map((asset) => ({
      kind: "instruction" as const,
      path: asset.path,
      contentHash: asset.contentHash,
    })),
    ...compiled.agentSnapshot.skills.map((asset) => ({
      kind: "skill" as const,
      path: asset.path,
      contentHash: asset.contentHash,
    })),
  ].sort((left, right) => left.path.localeCompare(right.path));
  const inactiveAgents = compiled.agentSnapshot.agents
    .map((asset) => ({ path: asset.path, contentHash: asset.contentHash }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    contentHash: contentHash({
      schemaVersion: "openpond.desktopWorkHarnessSurface.v1",
      components,
    }),
    components,
    inactiveAgents,
  };
}

function validateMemoryProposal(input: {
  proposal: HarnessImprovementProposal;
  now?: () => string;
}): HarnessTargetedValidationReceipt[] {
  const timestamp = (input.now ?? (() => new Date().toISOString()))();
  const edit = input.proposal.edits.find((candidate) => candidate.route === "memory");
  return input.proposal.validationPlan.map((plan) => {
    let status: HarnessTargetedValidationReceipt["status"] = "passed";
    let summary = "Memory candidate is bounded, scoped, and contains no obvious credential material.";
    try {
      if (plan.kind === "observed_recovery") {
        if (!input.proposal.evidence.some((evidence) => evidence.kind === "recovery")) {
          throw new Error("Observed-recovery validation requires recorded recovery evidence.");
        }
        summary = "Memory proposal is grounded in immutable recovery evidence.";
      } else if (plan.kind === "memory") {
        if (!edit || !/^memory\/[a-z0-9][a-z0-9-]{0,119}$/.test(edit.target)) {
          throw new Error("Memory proposal requires one safe memory/<slug> target.");
        }
        const expected = input.proposal.metadata.expectedMemory;
        if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
          throw new Error("Memory proposal requires an expected revision snapshot.");
        }
        const expectedRecord = expected as Record<string, unknown>;
        if (expectedRecord.key !== memoryKeyFromTarget(edit.target)) {
          throw new Error("Memory proposal expected revision targets a different key.");
        }
        if (
          expectedRecord.revision !== null &&
          (!Number.isInteger(expectedRecord.revision) || Number(expectedRecord.revision) < 1)
        ) {
          throw new Error("Memory proposal expected revision is invalid.");
        }
        if (
          expectedRecord.contentHash !== null &&
          typeof expectedRecord.contentHash !== "string"
        ) {
          throw new Error("Memory proposal expected content hash is invalid.");
        }
        if (
          expectedRecord.status !== null &&
          expectedRecord.status !== "active" &&
          expectedRecord.status !== "deleted"
        ) {
          throw new Error("Memory proposal expected status is invalid.");
        }
        if (
          expectedRecord.revision === null &&
          (expectedRecord.contentHash !== null || expectedRecord.status !== null)
        ) {
          throw new Error("New memory snapshot must not claim existing content or status.");
        }
        if (
          expectedRecord.revision !== null &&
          (typeof expectedRecord.contentHash !== "string" || expectedRecord.status === null)
        ) {
          throw new Error("Existing memory snapshot requires its content hash and status.");
        }
        if (edit.operation === "delete" && expectedRecord.status !== "active") {
          throw new Error("Memory deletion requires an active expected revision.");
        }
        if (edit.operation !== "delete") {
          if (!edit.content?.trim() || edit.content.length > 24_000) {
            throw new Error("Memory content must contain 1-24,000 characters.");
          }
          if (/\b(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]/i.test(edit.content)) {
            throw new Error("Memory content appears to contain credential material.");
          }
        }
      } else {
        status = "blocked";
        summary = `Memory validation cannot satisfy ${plan.kind}.`;
      }
    } catch (error) {
      status = "failed";
      summary = error instanceof Error ? error.message : String(error);
    }
    return createHarnessTargetedValidationReceipt({
      schemaVersion: "openpond.harnessTargetedValidationReceipt.v1",
      id: `validation-${input.proposal.id}-${plan.id}`,
      proposal: { id: input.proposal.id, contentHash: input.proposal.contentHash },
      validationId: plan.id,
      kind: plan.kind,
      status,
      summary,
      evidenceRefs: input.proposal.evidence,
      createdAt: timestamp,
      metadata: { externalState: "harness_memory" },
    });
  });
}

function memoryKeyFromTarget(target: string): string {
  const normalized = target.replaceAll("\\", "/");
  const match = /^memory\/([a-z0-9][a-z0-9-]{0,119})$/.exec(normalized);
  if (!match) throw new Error(`Invalid Harness memory target: ${target}.`);
  return match[1];
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
