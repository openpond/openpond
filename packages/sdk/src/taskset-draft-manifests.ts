import { canonicalJson } from "@openpond/harness";
import { TasksetDraftSchema, type TasksetDraft } from "./taskset-draft-document.js";
import { TasksetDraftFilePathSchema } from "./model-taskset-authoring-contracts.js";

export function configuredTasksetDraftFiles(draft: TasksetDraft): Array<{ relativePath: string; source: string }> {
  const configured: Array<{ relativePath: string; source: string }> = [];
  if (draft.output.renderer) {
    configured.push({
      relativePath: draft.output.renderer.module,
      source: `export async function ${draft.output.renderer.exportName}(output: unknown) {\n  // Return artifact paths or bytes derived from the model's structured output.\n  return output;\n}\n`,
    });
  }
  for (const grader of draft.graders) {
    if (grader.kind !== "custom_verifier") continue;
    configured.push({
      relativePath: grader.module,
      source: `export async function ${grader.exportName}(input: { output: unknown; task: unknown }) {\n  return { passed: false, score: 0, feedback: "Implement this verifier." };\n}\n`,
    });
  }
  if (draft.metrics.customAggregator) {
    configured.push({
      relativePath: draft.metrics.customAggregator.module,
      source: `export function ${draft.metrics.customAggregator.exportName}(scores: number[]) {\n  return scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : 0;\n}\n`,
    });
  }
  for (const file of configured) TasksetDraftFilePathSchema.parse(file.relativePath);
  return configured;
}

/** Canonical form-owned files have one structured document as their source. */
export function renderTasksetDraftManifests(input: unknown): Map<string, string> {
  const draft = TasksetDraftSchema.parse(input);
  return new Map([
    ["taskset.json", canonicalJson(draft)],
    ["tasks/tasks.jsonl", jsonLines(draft.tasks)],
    ["graders/graders.json", canonicalJson(draft.graders)],
    ["fixtures/grader-fixtures.json", canonicalJson(draft.graderFixtures)],
    ["metrics/policy.json", canonicalJson(draft.metrics)],
    ["assets/manifest.json", canonicalJson(draft.tasks.flatMap(task => task.assets ?? []))],
    ["environment/contract.json", canonicalJson(draft.environment)],
    ["rubrics/preference-review.md", rubricMarkdown(draft)],
    ["comparisons/policy.json", canonicalJson(draft.review)],
  ]);
}

function rubricMarkdown(draft: TasksetDraft): string {
  const criteria = draft.review.criteria.length
    ? `\n\n## Criteria\n\n${draft.review.criteria.map((criterion) =>
      `- **${criterion.label}** (${criterion.weight}): ${criterion.description}`
    ).join("\n")}`
    : "";
  return `# Preference review rubric\n\n${draft.review.rubric}${criteria}\n`;
}

function jsonLines(values: unknown[]): string {
  return values.length ? `${values.map((value) => JSON.stringify(value)).join("\n")}\n` : "";
}
