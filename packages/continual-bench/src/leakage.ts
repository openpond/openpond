import { contentHash } from "./hash.js";
import type { ContinualBenchSourceTask } from "./split.js";

export type ContinualBenchLeakageFinding = {
  kind: "duplicate_id" | "duplicate_content" | "family_overlap" | "prompt_overlap";
  leftPanel: string;
  rightPanel: string;
  leftTaskId: string;
  rightTaskId: string;
  similarity: number | null;
};

export type ContinualBenchLeakageAudit = {
  schemaVersion: "openpond.continualBenchLeakageAudit.v1";
  threshold: number;
  findings: ContinualBenchLeakageFinding[];
  contentHash: string;
};

export function auditContinualBenchLeakage(input: {
  panels: Array<{ id: string; tasks: ContinualBenchSourceTask[] }>;
  semanticSimilarityThreshold?: number;
  allowSharedFamiliesBetween?: Array<[string, string]>;
}): ContinualBenchLeakageAudit {
  const threshold = input.semanticSimilarityThreshold ?? 0.8;
  if (!(threshold > 0 && threshold <= 1)) throw new Error("semanticSimilarityThreshold must be in (0, 1].");
  const allowed = new Set((input.allowSharedFamiliesBetween ?? []).flatMap(([left, right]) => [`${left}\u0000${right}`, `${right}\u0000${left}`]));
  const findings: ContinualBenchLeakageFinding[] = [];
  for (let leftIndex = 0; leftIndex < input.panels.length; leftIndex += 1) {
    const leftPanel = input.panels[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < input.panels.length; rightIndex += 1) {
      const rightPanel = input.panels[rightIndex]!;
      for (const left of leftPanel.tasks) for (const right of rightPanel.tasks) {
        const base = { leftPanel: leftPanel.id, rightPanel: rightPanel.id, leftTaskId: left.id, rightTaskId: right.id };
        if (left.id === right.id) findings.push({ ...base, kind: "duplicate_id", similarity: 1 });
        else if (left.contentHash === right.contentHash) findings.push({ ...base, kind: "duplicate_content", similarity: 1 });
        if (left.familyId === right.familyId && !allowed.has(`${leftPanel.id}\u0000${rightPanel.id}`)) findings.push({ ...base, kind: "family_overlap", similarity: null });
        if (left.prompt && right.prompt) {
          const similarity = jaccard(left.prompt, right.prompt);
          if (similarity >= threshold) findings.push({ ...base, kind: "prompt_overlap", similarity });
        }
      }
    }
  }
  const release = {
    schemaVersion: "openpond.continualBenchLeakageAudit.v1" as const,
    threshold,
    findings: findings.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  };
  return { ...release, contentHash: contentHash(release) };
}

function jaccard(left: string, right: string): number {
  const tokens = (value: string) => new Set(value.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  const union = new Set([...leftTokens, ...rightTokens]);
  if (!union.size) return 1;
  let intersection = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) intersection += 1;
  return intersection / union.size;
}
