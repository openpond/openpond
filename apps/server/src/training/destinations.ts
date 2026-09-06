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

type TasksetResolver = (id: string, contentHash: string) => Promise<Taskset | null>;

export class PortablePreparationTrainingDestination
  implements TrainingDestination
{
  constructor(
    readonly id: Extract<
      TrainingDestinationId,
      "openpond_managed"
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
    const taskset = await this.options.resolveTaskset(plan.tasksetId, plan.tasksetHash);
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

function validateAgainst(taskset: Taskset, plan: TrainingPlan, destinationCapabilities: TrainingDestinationCapabilities) { return validateTrainingCompatibility({ taskset, plan, capabilities: destinationCapabilities }); }
