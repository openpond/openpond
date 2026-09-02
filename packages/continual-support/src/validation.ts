import { auditContinualBenchLeakage } from "./leakage.js";
import { ContinualBenchPortableManifestSchema, verifyPortableManifest, type ContinualBenchPortableManifest } from "./manifest.js";

export type ContinualBenchValidationIssue = {
  severity: "error" | "advisory";
  code: string;
  message: string;
  path: string;
};

export type ContinualBenchValidationReport = {
  valid: boolean;
  manifestHash: string | null;
  issues: ContinualBenchValidationIssue[];
  leakageHash: string | null;
};

export function validateContinualBenchManifest(value: unknown): ContinualBenchValidationReport {
  const parsed = ContinualBenchPortableManifestSchema.safeParse(value);
  if (!parsed.success) {
    return {
      valid: false,
      manifestHash: null,
      leakageHash: null,
      issues: parsed.error.issues.map((issue) => ({
        severity: "error",
        code: "schema",
        message: issue.message,
        path: issue.path.join("."),
      })),
    };
  }
  const manifest = parsed.data;
  const issues: ContinualBenchValidationIssue[] = [];
  if (!verifyPortableManifest(manifest)) issues.push({ severity: "error", code: "content_hash", message: "Manifest contentHash does not match its canonical payload.", path: "contentHash" });
  const taskById = new Map(manifest.tasks.map((task) => [task.id, task]));
  const correctionSiblingPairs: Array<[string, string]> = [];
  for (const pass of manifest.passes) {
    const correction = manifest.panels.find((panel) => panel.role === "correction" && panel.passLabel === pass.label);
    const sibling = manifest.panels.find((panel) => panel.role === "sibling_verification" && panel.passLabel === pass.label);
    if (!correction || !sibling) {
      issues.push({ severity: "error", code: "missing_holdout", message: `Pass ${pass.label} requires both correction and sibling-verification panels.`, path: "panels" });
      continue;
    }
    correctionSiblingPairs.push([correction.id, sibling.id]);
    const correctionFamilies = new Set(correction.taskIds.map((id) => taskById.get(id)?.familyId));
    const siblingFamilies = new Set(sibling.taskIds.map((id) => taskById.get(id)?.familyId));
    for (const familyId of pass.familyIds) {
      if (!correctionFamilies.has(familyId) || !siblingFamilies.has(familyId)) {
        issues.push({ severity: "error", code: "insufficient_family", message: `Pass ${pass.label} family ${familyId} lacks a correction or sibling case; the holdout was not weakened.`, path: "passes" });
      }
    }
  }
  const leakage = auditContinualBenchLeakage({
    panels: manifest.panels.filter((panel) => panel.role !== "cumulative_known" && panel.role !== "training_eligible").map((panel) => ({
      id: panel.id,
      tasks: panel.taskIds.map((id) => {
        const task = taskById.get(id)!;
        return { id: task.id, familyId: task.familyId, contentHash: task.contentHash, prompt: task.prompt };
      }),
    })),
    allowSharedFamiliesBetween: correctionSiblingPairs,
    semanticSimilarityThreshold: manifest.split.semanticSimilarityThreshold,
  });
  for (const finding of leakage.findings) {
    issues.push({
      severity: "error",
      code: `leakage_${finding.kind}`,
      message: `${finding.leftTaskId} in ${finding.leftPanel} overlaps ${finding.rightTaskId} in ${finding.rightPanel}.`,
      path: "panels",
    });
  }
  return { valid: !issues.some((issue) => issue.severity === "error"), manifestHash: manifest.contentHash, issues, leakageHash: leakage.contentHash };
}

export function requireValidContinualBenchManifest(value: unknown): ContinualBenchPortableManifest {
  const report = validateContinualBenchManifest(value);
  if (!report.valid) throw new Error(report.issues.map((issue) => `${issue.code}: ${issue.message}`).join("\n"));
  return ContinualBenchPortableManifestSchema.parse(value);
}
