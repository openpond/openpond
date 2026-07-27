import {
  TrainingDestinationCapabilitiesSchema,
  type Taskset,
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
  constructor(readonly id: Exclude<TrainingDestinationId, "export" | "local_cpu_fixture">, private readonly reason: string, private readonly resolveTaskset: TasksetResolver) {}
  async capabilities(): Promise<TrainingDestinationCapabilities> { return capabilities(this.id, false, false, this.reason); }
  async validate(plan: TrainingPlan): Promise<TrainingCompatibilityReport> { const taskset = await this.resolveTaskset(plan.tasksetId); if (!taskset) throw new Error("Taskset not found."); return validateAgainst(taskset, plan, await this.capabilities()); }
  async quote(): Promise<{ estimatedCostUsd: number | null; assumptions: string[] }> { throw new Error(this.reason); }
  async launch(): Promise<TrainingJob> { throw new Error(this.reason); }
  async status(): Promise<TrainingJob> { throw new Error(this.reason); }
  async cancel(): Promise<TrainingJob> { throw new Error(this.reason); }
  async collect(): Promise<TrainingArtifact[]> { throw new Error(this.reason); }
}

export class PortablePreparationTrainingDestination
  implements TrainingDestination
{
  constructor(
    readonly id: Extract<
      TrainingDestinationId,
      "ssh_gpu" | "prime_hosted"
    >,
    private readonly options: {
      resolveTaskset: TasksetResolver;
      estimatedCostUsd: number | null;
      methods: TrainingDestinationCapabilities["methods"];
      environmentPlacements: TrainingDestinationCapabilities["environmentPlacements"];
      assumptions: string[];
      modelAllowlist?: string[];
    },
  ) {}

  async capabilities(): Promise<TrainingDestinationCapabilities> {
    return TrainingDestinationCapabilitiesSchema.parse({
      schemaVersion: "openpond.trainingDestinationCapabilities.v1",
      destinationId: this.id,
      available: true,
      methods: this.options.methods,
      parameterizations: ["lora"],
      modelAllowlist: this.options.modelAllowlist ?? [],
      maxDatasetBytes: null,
      environmentPlacements: this.options.environmentPlacements,
      nonProduction: true,
      unavailableReason: null,
      checkedAt: new Date().toISOString(),
    });
  }

  async validate(
    plan: TrainingPlan,
  ): Promise<TrainingCompatibilityReport> {
    const taskset = await this.options.resolveTaskset(plan.tasksetId);
    if (!taskset) throw new Error("Taskset not found.");
    return validateAgainst(taskset, plan, await this.capabilities());
  }

  async quote(): Promise<{
    estimatedCostUsd: number | null;
    assumptions: string[];
  }> {
    return {
      estimatedCostUsd: this.options.estimatedCostUsd,
      assumptions: this.options.assumptions,
    };
  }

  async launch(): Promise<TrainingJob> {
    throw new Error(
      `${this.id} launches only through the resolved portable adapter graph.`,
    );
  }

  async status(): Promise<TrainingJob> {
    throw new Error(`${this.id} has no legacy destination job.`);
  }

  async cancel(): Promise<TrainingJob> {
    throw new Error(`${this.id} has no legacy destination job.`);
  }

  async collect(): Promise<TrainingArtifact[]> {
    return [];
  }
}

function capabilities(destinationId: TrainingDestinationId, available: boolean, nonProduction: boolean, unavailableReason: string | null): TrainingDestinationCapabilities {
  return TrainingDestinationCapabilitiesSchema.parse({ schemaVersion: "openpond.trainingDestinationCapabilities.v1", destinationId, available, methods: ["sft"], parameterizations: ["lora"], modelAllowlist: [], maxDatasetBytes: destinationId === "local_cpu_fixture" ? 10_000_000 : null, environmentPlacements: ["none"], nonProduction, unavailableReason, checkedAt: new Date().toISOString() });
}
function validateAgainst(taskset: Taskset, plan: TrainingPlan, destinationCapabilities: TrainingDestinationCapabilities) { return validateTrainingCompatibility({ taskset, plan, capabilities: destinationCapabilities }); }
