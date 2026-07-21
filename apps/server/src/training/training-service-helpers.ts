import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  selectPreferredRftSignalReport,
  type BaselineReport,
  type RftRecipe,
  type Taskset,
} from "@openpond/contracts";
import { contentHash, sha256 } from "@openpond/taskset-sdk";

export function withAuthoritativeRecipeHashes(
  taskset: Taskset,
  recipe: unknown,
): unknown {
  if (!recipe || typeof recipe !== "object" || Array.isArray(recipe)) {
    return recipe;
  }
  const candidate = recipe as Record<string, unknown>;
  if (candidate.method !== "grpo") return recipe;
  const reward =
    candidate.reward
    && typeof candidate.reward === "object"
    && !Array.isArray(candidate.reward)
      ? candidate.reward as Record<string, unknown>
      : {};
  return {
    ...candidate,
    reward: {
      ...reward,
      graderHash: contentHash(taskset.graders),
    },
  };
}

export function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== ""
    && !relative.startsWith("..")
    && !path.isAbsolute(relative);
}

export async function assertArtifactIntegrity(
  artifactPath: string,
  expectedHash: string,
  expectedSize: number,
): Promise<void> {
  const bytes = await readFile(artifactPath);
  if (
    bytes.byteLength !== expectedSize
    || sha256(bytes) !== expectedHash
  ) {
    throw new Error(
      "Model promotion refused an artifact that failed integrity verification.",
    );
  }
}

export async function requireFireworksApprovalActor(
  resolveApprovalActor: (() => Promise<string | null>) | undefined,
): Promise<string> {
  const actor = (await resolveApprovalActor?.())?.trim() ?? "";
  if (!actor) {
    throw new Error(
      "Fireworks training requires a signed-in OpenPond account profile with a handle.",
    );
  }
  return actor;
}

export function matchingRftSignalGate(
  reports: BaselineReport[],
  recipe: RftRecipe,
) {
  const report = selectPreferredRftSignalReport(reports, {
    split: "train",
    taskCount: recipe.dataset.maxExamples,
    attemptsPerTask: recipe.rollout.groupSize,
    selectionSeed: recipe.rollout.seed,
    selectionStrategy: recipe.dataset.selectionStrategy,
    model: {
      providerId: "fireworks",
      modelId: recipe.baseModel.id,
    },
    sampling: {
      maxOutputTokens: recipe.rollout.maxOutputTokens,
      temperature: recipe.rollout.temperature,
      topP: recipe.rollout.topP,
    },
  });
  if (!report?.scope || !report.rftSignal) return null;
  return {
    baselineReportId: report.id,
    baselineReportHash: contentHash(report),
    scope: report.scope,
    signal: report.rftSignal,
  };
}
