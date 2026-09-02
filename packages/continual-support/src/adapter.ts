import type { ContinualBenchPortableManifest, ContinualBenchPortablePanel, ContinualBenchPortableTask } from "./manifest.js";
import type { ContinualBenchPortableReport } from "./report.js";

export type ContinualBenchDisclosurePhase = "review" | "evaluation" | "final";

export type ContinualBenchAdapterValidation = {
  valid: boolean;
  issues: Array<{ code: string; message: string; path?: string }>;
};

export type ContinualBenchRunResult = {
  comparisonSeriesId: string;
  canonicalUrl: string;
  protocolHash: string;
};

export interface ContinualBenchRunnerAdapter<TContext = unknown> {
  readonly id: string;
  validate(manifest: ContinualBenchPortableManifest, context: TContext): Promise<ContinualBenchAdapterValidation>;
  run(manifest: ContinualBenchPortableManifest, context: TContext): Promise<ContinualBenchRunResult>;
  report(comparisonSeriesId: string, context: TContext): Promise<ContinualBenchPortableReport>;
}

export function disclosedPanels(
  manifest: ContinualBenchPortableManifest,
  phase: ContinualBenchDisclosurePhase,
): ContinualBenchPortablePanel[] {
  const phaseRank = { review: 0, evaluation: 1, final: 2 } as const;
  return manifest.panels.filter((panel) => phaseRank[panel.disclosurePhase] <= phaseRank[phase]);
}

export function optimizerTasksForPass(
  manifest: ContinualBenchPortableManifest,
  passLabel: string,
): ContinualBenchPortableTask[] {
  const taskById = new Map(manifest.tasks.map((task) => [task.id, task]));
  const ids = new Set(manifest.panels
    .filter((panel) => panel.optimizerEligible && panel.role === "correction" && panel.passLabel === passLabel)
    .flatMap((panel) => panel.taskIds));
  return [...ids].map((id) => {
    const task = taskById.get(id);
    if (!task) throw new Error(`Optimizer task ${id} is absent from the manifest inventory.`);
    return task;
  });
}

export const CONTINUAL_SUPPORT_COMMANDS = Object.freeze({
  init: "openpond continual init --from ./tasks.jsonl",
  validate: "openpond continual validate ./continual-support.yaml",
  run: "openpond continual run ./continual-support.yaml",
  report: "openpond continual report <comparison-series-id>",
});
