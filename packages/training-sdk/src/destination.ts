import type {
  TrainingApproval,
  TrainingArtifact,
  TrainingCompatibilityReport,
  TrainingDestinationCapabilities,
  TrainingDestinationId,
  TrainingJob,
  TrainingPlan,
} from "@openpond/contracts";

export interface TrainingDestination {
  readonly id: TrainingDestinationId;
  capabilities(): Promise<TrainingDestinationCapabilities>;
  validate(plan: TrainingPlan): Promise<TrainingCompatibilityReport>;
  quote(plan: TrainingPlan): Promise<{ estimatedCostUsd: number | null; assumptions: string[] }>;
  launch(plan: TrainingPlan, approval: TrainingApproval): Promise<TrainingJob>;
  status(jobId: string): Promise<TrainingJob>;
  cancel(jobId: string): Promise<TrainingJob>;
  collect(jobId: string): Promise<TrainingArtifact[]>;
}

export class TrainingDestinationRegistry {
  private readonly destinations = new Map<TrainingDestinationId, TrainingDestination>();

  register(destination: TrainingDestination): void {
    if (this.destinations.has(destination.id)) throw new Error(`Training destination ${destination.id} is already registered.`);
    this.destinations.set(destination.id, destination);
  }

  get(id: TrainingDestinationId): TrainingDestination {
    const destination = this.destinations.get(id);
    if (!destination) throw new Error(`Training destination ${id} is not registered.`);
    return destination;
  }

  list(): TrainingDestination[] { return [...this.destinations.values()]; }
}
