import { contentHash } from "./hash.js";

export type ContinualBenchSourceTask = {
  id: string;
  familyId: string;
  contentHash: string;
  prompt?: string;
  criticalInvariantIds?: string[];
};

export type ContinualBenchPassAllocation = {
  label: string;
  familyIds: string[];
};

export type ContinualBenchAllocatedTask = ContinualBenchSourceTask & {
  passLabel: string;
  panelRole: "correction" | "sibling_verification";
  optimizerEligible: boolean;
};

export type ContinualBenchSplit = {
  schemaVersion: "openpond.continualBenchSplit.v1";
  seed: string;
  allocations: ContinualBenchAllocatedTask[];
  families: Array<{
    familyId: string;
    passLabel: string;
    correctionTaskIds: string[];
    siblingTaskIds: string[];
  }>;
  advisories: Array<{
    code: "insufficient_siblings" | "unassigned_family";
    familyId: string;
    taskCount: number;
  }>;
  contentHash: string;
};

export function createContinualBenchSplit(input: {
  tasks: ContinualBenchSourceTask[];
  passes: ContinualBenchPassAllocation[];
  seed: string;
  correctionCasesPerFamily?: number;
  correctionSelection?: "stable_hash" | "minimize_prompt_similarity";
}): ContinualBenchSplit {
  const correctionCount = input.correctionCasesPerFamily ?? 1;
  if (!Number.isInteger(correctionCount) || correctionCount < 1) throw new Error("correctionCasesPerFamily must be a positive integer.");
  const byId = new Map<string, ContinualBenchSourceTask>();
  const byFamily = new Map<string, ContinualBenchSourceTask[]>();
  for (const task of input.tasks) {
    if (byId.has(task.id)) throw new Error(`Duplicate task id: ${task.id}`);
    byId.set(task.id, task);
    const family = byFamily.get(task.familyId) ?? [];
    family.push(task);
    byFamily.set(task.familyId, family);
  }
  const passByFamily = new Map<string, string>();
  for (const pass of input.passes) {
    if (!pass.label.trim()) throw new Error("Pass labels cannot be empty.");
    for (const familyId of pass.familyIds) {
      if (passByFamily.has(familyId)) throw new Error(`Family ${familyId} is assigned to more than one pass.`);
      passByFamily.set(familyId, pass.label);
    }
  }
  const allocations: ContinualBenchAllocatedTask[] = [];
  const families: ContinualBenchSplit["families"] = [];
  const advisories: ContinualBenchSplit["advisories"] = [];
  for (const [familyId, tasks] of [...byFamily].sort(([left], [right]) => left.localeCompare(right))) {
    const passLabel = passByFamily.get(familyId);
    if (!passLabel) {
      advisories.push({ code: "unassigned_family", familyId, taskCount: tasks.length });
      continue;
    }
    let ordered = [...tasks].sort((left, right) => {
      const leftKey = contentHash([input.seed, familyId, left.id, left.contentHash]);
      const rightKey = contentHash([input.seed, familyId, right.id, right.contentHash]);
      return leftKey.localeCompare(rightKey) || left.id.localeCompare(right.id);
    });
    if (ordered.length <= correctionCount) {
      advisories.push({ code: "insufficient_siblings", familyId, taskCount: ordered.length });
      continue;
    }
    if (input.correctionSelection === "minimize_prompt_similarity" && correctionCount === 1 && ordered.every((task) => task.prompt)) {
      ordered = [...ordered].sort((left, right) => {
        const leftMaximum = maximumSiblingSimilarity(left, ordered);
        const rightMaximum = maximumSiblingSimilarity(right, ordered);
        return leftMaximum - rightMaximum || left.id.localeCompare(right.id);
      });
    }
    const correction = ordered.slice(0, correctionCount);
    const siblings = ordered.slice(correctionCount);
    allocations.push(
      ...correction.map((task) => ({ ...task, passLabel, panelRole: "correction" as const, optimizerEligible: true })),
      ...siblings.map((task) => ({ ...task, passLabel, panelRole: "sibling_verification" as const, optimizerEligible: false })),
    );
    families.push({ familyId, passLabel, correctionTaskIds: correction.map((task) => task.id), siblingTaskIds: siblings.map((task) => task.id) });
  }
  for (const familyId of passByFamily.keys()) {
    if (!byFamily.has(familyId)) throw new Error(`Assigned family ${familyId} has no source tasks.`);
  }
  const release = {
    schemaVersion: "openpond.continualBenchSplit.v1" as const,
    seed: input.seed,
    allocations: allocations.sort((left, right) => left.passLabel.localeCompare(right.passLabel) || left.familyId.localeCompare(right.familyId) || left.id.localeCompare(right.id)),
    families: families.sort((left, right) => left.passLabel.localeCompare(right.passLabel) || left.familyId.localeCompare(right.familyId)),
    advisories: advisories.sort((left, right) => left.familyId.localeCompare(right.familyId) || left.code.localeCompare(right.code)),
  };
  return { ...release, contentHash: contentHash(release) };
}

function maximumSiblingSimilarity(task: ContinualBenchSourceTask, family: ContinualBenchSourceTask[]): number {
  return Math.max(...family.filter((candidate) => candidate.id !== task.id).map((candidate) => jaccard(task.prompt!, candidate.prompt!)));
}

function jaccard(left: string, right: string): number {
  const tokenize = (value: string) => new Set(value.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const leftTokens = tokenize(left);
  const rightTokens = tokenize(right);
  const union = new Set([...leftTokens, ...rightTokens]);
  if (!union.size) return 1;
  let intersection = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) intersection += 1;
  return intersection / union.size;
}
