import {
  TrainingDestinationCapabilitiesSchema,
  TrainingJobSchema,
  type Taskset,
  type TrainingApproval,
  type TrainingArtifact,
  type TrainingCompatibilityReport,
  type TrainingDestinationCapabilities,
  type TrainingDestinationId,
  type TrainingJob,
  type TrainingPlan,
} from "@openpond/contracts";
import { validateTrainingCompatibility, type TrainingDestination } from "@openpond/training-sdk";

type TasksetResolver = (id: string) => Promise<Taskset | null>;

export class ExportTrainingDestination implements TrainingDestination {
  readonly id = "export" as const;
  constructor(private readonly resolveTaskset: TasksetResolver) {}
  async capabilities(): Promise<TrainingDestinationCapabilities> { return capabilities(this.id, true, false, null); }
  async validate(plan: TrainingPlan): Promise<TrainingCompatibilityReport> { return validateAgainst(await this.requireTaskset(plan.tasksetId), plan, await this.capabilities()); }
  async quote(): Promise<{ estimatedCostUsd: number | null; assumptions: string[] }> { return { estimatedCostUsd: 0, assumptions: ["Export only; no trainer is launched."] }; }
  async launch(): Promise<TrainingJob> { throw new Error("Export is not an executable training destination."); }
  async status(): Promise<TrainingJob> { throw new Error("Export has no job lifecycle."); }
  async cancel(): Promise<TrainingJob> { throw new Error("Export has no job lifecycle."); }
  async collect(): Promise<TrainingArtifact[]> { return []; }
  private async requireTaskset(id: string) { const taskset = await this.resolveTaskset(id); if (!taskset) throw new Error("Taskset not found."); return taskset; }
}

export class UnavailableTrainingDestination implements TrainingDestination {
  constructor(readonly id: Extract<TrainingDestinationId, "openpond_managed" | "custom">, private readonly reason: string, private readonly resolveTaskset: TasksetResolver) {}
  async capabilities(): Promise<TrainingDestinationCapabilities> { return capabilities(this.id, false, this.id === "custom", this.reason); }
  async validate(plan: TrainingPlan): Promise<TrainingCompatibilityReport> { const taskset = await this.resolveTaskset(plan.tasksetId); if (!taskset) throw new Error("Taskset not found."); return validateAgainst(taskset, plan, await this.capabilities()); }
  async quote(): Promise<{ estimatedCostUsd: number | null; assumptions: string[] }> { throw new Error(this.reason); }
  async launch(): Promise<TrainingJob> { throw new Error(this.reason); }
  async status(): Promise<TrainingJob> { throw new Error(this.reason); }
  async cancel(): Promise<TrainingJob> { throw new Error(this.reason); }
  async collect(): Promise<TrainingArtifact[]> { throw new Error(this.reason); }
}

export function createImmediateCustomExample(input: { resolveTaskset: TasksetResolver }): TrainingDestination {
  const jobs = new Map<string, TrainingJob>();
  return {
    id: "custom",
    capabilities: async () => capabilities("custom", true, true, null),
    validate: async (plan) => { const taskset = await input.resolveTaskset(plan.tasksetId); if (!taskset) throw new Error("Taskset not found."); return validateAgainst(taskset, plan, capabilities("custom", true, true, null)); },
    quote: async () => ({ estimatedCostUsd: 0, assumptions: ["Example adapter performs no training and is for offline conformance only."] }),
    launch: async (plan: TrainingPlan, approval: TrainingApproval) => {
      const timestamp = new Date().toISOString();
      const job = TrainingJobSchema.parse({ schemaVersion: "openpond.trainingJob.v1", id: `custom_example_${approval.id}`, planId: plan.id, bundleHash: approval.bundleHash, approvalId: approval.id, destinationId: "custom", status: "succeeded", nonProduction: true, workerPid: null, startedAt: timestamp, completedAt: timestamp, error: null, createdAt: timestamp, updatedAt: timestamp, metadata: { exampleAdapter: true, performedTraining: false } });
      jobs.set(job.id, job);
      return job;
    },
    status: async (id) => { const job = jobs.get(id); if (!job) throw new Error("Custom example job not found."); return job; },
    cancel: async (id) => { const job = jobs.get(id); if (!job) throw new Error("Custom example job not found."); return job; },
    collect: async () => [],
  };
}

function capabilities(destinationId: TrainingDestinationId, available: boolean, nonProduction: boolean, unavailableReason: string | null): TrainingDestinationCapabilities {
  return TrainingDestinationCapabilitiesSchema.parse({ schemaVersion: "openpond.trainingDestinationCapabilities.v1", destinationId, available, methods: ["sft"], parameterizations: ["lora"], modelAllowlist: [], maxDatasetBytes: destinationId === "local_cpu_fixture" ? 10_000_000 : null, environmentPlacements: ["none"], nonProduction, unavailableReason, checkedAt: new Date().toISOString() });
}
function validateAgainst(taskset: Taskset, plan: TrainingPlan, destinationCapabilities: TrainingDestinationCapabilities) { return validateTrainingCompatibility({ taskset, plan, capabilities: destinationCapabilities }); }
