import { contentHash } from "./hash.js";
import type { ContinualBenchPortableManifest, ContinualBenchPortableTask } from "./manifest.js";
import type { ContinualBenchIssueCase } from "./schema.js";
import type { ContinualBenchSplit } from "./split.js";

export type ContinualBenchPanelAllocation = {
  id: string;
  role: "correction" | "sibling_verification" | "cumulative_known" | "training_eligible";
  passLabel: string | null;
  taskIds: string[];
  familyIds: string[];
  optimizerEligible: boolean;
  contentHash: string;
};

export function createContinualBenchPanelAllocations(split: ContinualBenchSplit): ContinualBenchPanelAllocation[] {
  const panels: ContinualBenchPanelAllocation[] = [];
  const orderedFamilies = [...split.families].sort((left, right) => left.passLabel.localeCompare(right.passLabel));
  for (const family of orderedFamilies) {
    panels.push(sealPanel({ id: `${family.passLabel.toLowerCase()}-correction`, role: "correction", passLabel: family.passLabel, taskIds: family.correctionTaskIds, familyIds: [family.familyId], optimizerEligible: true }));
    panels.push(sealPanel({ id: `${family.passLabel.toLowerCase()}-siblings`, role: "sibling_verification", passLabel: family.passLabel, taskIds: family.siblingTaskIds, familyIds: [family.familyId], optimizerEligible: false }));
  }
  for (let index = 0; index < orderedFamilies.length; index += 1) {
    const through = orderedFamilies.slice(0, index + 1);
    panels.push(sealPanel({
      id: `known-${through[index]!.passLabel.toLowerCase()}`,
      role: "cumulative_known",
      passLabel: through[index]!.passLabel,
      taskIds: through.flatMap((family) => [...family.correctionTaskIds, ...family.siblingTaskIds]),
      familyIds: through.map((family) => family.familyId),
      optimizerEligible: false,
    }));
  }
  panels.push(sealPanel({
    id: "training-eligible",
    role: "training_eligible",
    passLabel: null,
    taskIds: orderedFamilies.flatMap((family) => family.correctionTaskIds),
    familyIds: orderedFamilies.map((family) => family.familyId),
    optimizerEligible: true,
  }));
  return panels;
}

export function issuePacketCasesForFamily(
  split: ContinualBenchSplit,
  familyId: string,
  criticalInvariantIds: string[] = [],
): ContinualBenchIssueCase[] {
  const cases = split.allocations.filter((entry) => entry.familyId === familyId).map((entry) => ({
    taskId: entry.id,
    taskContentHash: entry.contentHash,
    panelRole: entry.panelRole,
    passLabel: entry.passLabel,
    optimizerEligible: entry.optimizerEligible,
    criticalInvariantIds,
  }));
  if (!cases.length) throw new Error(`Issue family ${familyId} has no split allocations.`);
  return cases;
}

export function correctionPanelIdsForSchedule(input: {
  split: ContinualBenchSplit;
  label: string;
  role: "seed" | "daily_residual" | "weekly_rollup" | "full_refresh";
  weeklyExcludeLabels?: string[];
}): string[] {
  const labels = input.split.families.map((family) => family.passLabel);
  if (input.role === "full_refresh") return labels.map((label) => `${label.toLowerCase()}-correction`);
  if (input.role === "weekly_rollup") {
    const excluded = new Set(input.weeklyExcludeLabels ?? []);
    return labels.filter((label) => !excluded.has(label)).map((label) => `${label.toLowerCase()}-correction`);
  }
  if (!labels.includes(input.label)) throw new Error(`Schedule ${input.label} has no correction family.`);
  return [`${input.label.toLowerCase()}-correction`];
}

export function createPortablePublicationPlan(manifest: ContinualBenchPortableManifest) {
  assertOptimizerIsolation(manifest);
  const taskById = new Map(manifest.tasks.map((task) => [task.id, task]));
  const releases = manifest.panels.map((panel) => {
    const tasks = panel.taskIds.map((id) => taskById.get(id)!);
    const source = {
      id: panel.id,
      role: panel.role,
      passLabel: panel.passLabel,
      disclosurePhase: panel.disclosurePhase,
      optimizerEligible: panel.optimizerEligible,
      tasks: tasks.map((task) => ({ id: task.id, contentHash: task.contentHash })),
    };
    return { ...source, contentHash: contentHash(source) };
  });
  const plan = { schemaVersion: "openpond.continualBenchPublicationPlan.v1" as const, manifest: { id: manifest.id, revision: manifest.revision, contentHash: manifest.contentHash }, releases };
  return { ...plan, contentHash: contentHash(plan) };
}

export function auditPriorExposure(input: {
  selectedTasks: ContinualBenchPortableTask[];
  optimizerTaskIds?: string[];
  disclosedEvaluationTaskIds?: string[];
}) {
  const selected = new Set(input.selectedTasks.map((task) => task.id));
  const optimizer = new Set(input.optimizerTaskIds ?? []);
  const disclosed = new Set(input.disclosedEvaluationTaskIds ?? []);
  const release = {
    schemaVersion: "openpond.continualBenchPriorExposureAudit.v1" as const,
    selectedTaskIds: [...selected].sort(),
    optimizerOverlapTaskIds: [...selected].filter((id) => optimizer.has(id)).sort(),
    disclosedEvaluationOverlapTaskIds: [...selected].filter((id) => disclosed.has(id)).sort(),
  };
  return { ...release, contentHash: contentHash(release) };
}

export function assertNoPriorExposure(audit: ReturnType<typeof auditPriorExposure>): void {
  if (audit.optimizerOverlapTaskIds.length || audit.disclosedEvaluationOverlapTaskIds.length) {
    throw new Error("Selected tasks overlap prior optimizer or disclosed evaluation evidence.");
  }
}

export function assertOptimizerIsolation(manifest: ContinualBenchPortableManifest): void {
  const hiddenRoles = new Set(["sibling_verification", "development", "retained", "frozen_final"]);
  const forbidden = new Set(manifest.panels.filter((panel) => hiddenRoles.has(panel.role)).flatMap((panel) => panel.taskIds));
  const optimizer = manifest.panels.filter((panel) => panel.optimizerEligible).flatMap((panel) => panel.taskIds);
  const overlaps = optimizer.filter((id) => forbidden.has(id));
  if (overlaps.length) throw new Error(`Hidden evaluation tasks are optimizer eligible: ${[...new Set(overlaps)].sort().join(", ")}`);
}

function sealPanel(input: Omit<ContinualBenchPanelAllocation, "contentHash">): ContinualBenchPanelAllocation {
  const normalized = { ...input, taskIds: [...input.taskIds].sort(), familyIds: [...input.familyIds].sort() };
  return { ...normalized, contentHash: contentHash(normalized) };
}
