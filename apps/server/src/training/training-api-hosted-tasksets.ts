import { TasksetDraftSchema, TasksetSchema } from "@openpond/contracts";
import { materializePortableTasksetRelease } from "@openpond/taskset-sdk";

import type { createBenchmarkTasksetService } from "./benchmark-tasksets.js";
import type { createModelProjectHostingService } from "./model-project-hosting.js";

type BenchmarkTasksets = ReturnType<typeof createBenchmarkTasksetService>;
type ModelProjectHosting = ReturnType<typeof createModelProjectHostingService>;

export async function publishTasksetToHostedProject(input: {
  benchmarkTasksets: BenchmarkTasksets;
  draft: ReturnType<typeof TasksetDraftSchema.parse>;
  modelId: string | null;
  modelProjectHosting?: ModelProjectHosting;
  taskset: ReturnType<typeof TasksetSchema.parse>;
}) {
  if (!input.modelId || !input.modelProjectHosting) {
    return {
      draft: input.draft,
      taskset: input.taskset,
      hostedSync: { state: "local" as const, error: null },
    };
  }
  const release = await input.benchmarkTasksets.releaseForTaskset(input.taskset)
    ?? materializePortableTasksetRelease({
      taskset: input.taskset,
      adapterId: "openpond-preference-comparisons-v1",
    }).tasksetRelease;
  try {
    await input.modelProjectHosting.publishTaskset({
      projectId: input.modelId,
      taskset: input.taskset,
      release,
    });
    return {
      draft: input.draft,
      taskset: input.taskset,
      hostedSync: { state: "synced" as const, error: null },
    };
  } catch (caught) {
    return {
      draft: input.draft,
      taskset: input.taskset,
      hostedSync: {
        state: "sync_failed" as const,
        error: caught instanceof Error ? caught.message : String(caught),
      },
    };
  }
}
