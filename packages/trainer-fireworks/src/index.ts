import type {
  AdapterValidationReceipt,
  LearningSignalBatch,
  ResolvedTrainingPlan,
  TrainingArtifacts,
  TrainingEngineCapabilities,
  TrainingExecutionRef,
  TrainingExecutionStatus,
} from "@openpond/contracts";
import type { TrainingEngineAdapter } from "@openpond/training-sdk";

export interface FireworksManagedTrainingClient {
  capabilities(): Promise<TrainingEngineCapabilities>;
  validate(plan: ResolvedTrainingPlan): Promise<AdapterValidationReceipt>;
  uploadSignals(input: {
    manifestId: string;
    manifestHash: string;
    batch: LearningSignalBatch;
  }): Promise<{ datasetId: string; immutableRevision: string }>;
  launch(input: {
    plan: ResolvedTrainingPlan;
    datasetRevisions: string[];
    idempotencyKey: string;
  }): Promise<TrainingExecutionRef>;
  status(ref: TrainingExecutionRef): Promise<TrainingExecutionStatus>;
  logs(ref: TrainingExecutionRef, cursor?: string): Promise<{
    cursor: string;
    entries: Array<{ timestamp: string; level: string; message: string }>;
  }>;
  cancel(ref: TrainingExecutionRef): Promise<void>;
  collect(ref: TrainingExecutionRef): Promise<TrainingArtifacts>;
}

export class FireworksTrainingEngineAdapter
  implements TrainingEngineAdapter
{
  readonly id: string;
  private readonly datasets = new Map<string, string[]>();

  constructor(
    private readonly client: FireworksManagedTrainingClient,
    id = "fireworks",
  ) {
    this.id = id;
  }

  async capabilities(): Promise<TrainingEngineCapabilities> {
    return this.client.capabilities();
  }

  async validate(
    plan: ResolvedTrainingPlan,
  ): Promise<AdapterValidationReceipt> {
    return this.client.validate(plan);
  }

  async consumeSignals(
    ref: TrainingExecutionRef,
    batch: LearningSignalBatch,
  ): Promise<void> {
    const upload = await this.client.uploadSignals({
      manifestId: batch.manifestId,
      manifestHash: batch.manifestHash,
      batch,
    });
    const revisions = this.datasets.get(ref.runId) ?? [];
    revisions.push(`${upload.datasetId}@${upload.immutableRevision}`);
    this.datasets.set(ref.runId, revisions);
  }

  async launch(plan: ResolvedTrainingPlan): Promise<TrainingExecutionRef> {
    const ref = await this.client.launch({
      plan,
      datasetRevisions: this.datasets.get(plan.manifest.id) ?? [],
      idempotencyKey: plan.contentHash,
    });
    if (ref.adapterId !== this.id) {
      throw new Error("Fireworks returned an execution for another adapter.");
    }
    return ref;
  }

  async status(
    ref: TrainingExecutionRef,
  ): Promise<TrainingExecutionStatus> {
    return this.client.status(ref);
  }

  async logs(ref: TrainingExecutionRef, cursor?: string) {
    return this.client.logs(ref, cursor);
  }

  async cancel(ref: TrainingExecutionRef): Promise<void> {
    await this.client.cancel(ref);
  }

  async collect(ref: TrainingExecutionRef): Promise<TrainingArtifacts> {
    return this.client.collect(ref);
  }
}
