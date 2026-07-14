import {
  TrainingDestinationCapabilitiesSchema,
  type ComputeInventory,
  type TrainingApproval,
  type TrainingArtifact,
  type TrainingCompatibilityReport,
  type TrainingDestinationCapabilities,
  type TrainingJob,
  type TrainingPlan,
  type Taskset,
} from "@openpond/contracts";
import { validateTrainingCompatibility, type TrainingDestination } from "@openpond/training-sdk";

type HardwareDestinationId = "local_cuda" | "local_mlx";

export class HardwareGatedTrainingDestination implements TrainingDestination {
  constructor(readonly id: HardwareDestinationId, private readonly deps: { inventory: () => Promise<ComputeInventory | null>; resolveTaskset: (id: string) => Promise<Taskset | null> }) {}

  async capabilities(): Promise<TrainingDestinationCapabilities> {
    const unavailableReason = capabilityReason(this.id, await this.deps.inventory());
    return TrainingDestinationCapabilitiesSchema.parse({ schemaVersion: "openpond.trainingDestinationCapabilities.v1", destinationId: this.id, available: false, methods: ["sft"], parameterizations: ["lora"], modelAllowlist: ["HuggingFaceTB/SmolLM2-135M-Instruct"], maxDatasetBytes: 10_000_000, environmentPlacements: ["local"], nonProduction: true, unavailableReason, checkedAt: new Date().toISOString() });
  }

  async validate(plan: TrainingPlan): Promise<TrainingCompatibilityReport> {
    const taskset = await this.deps.resolveTaskset(plan.tasksetId);
    if (!taskset) throw new Error("Taskset not found.");
    return validateTrainingCompatibility({ taskset, plan, capabilities: await this.capabilities() });
  }

  async quote(): Promise<{ estimatedCostUsd: number | null; assumptions: string[] }> { throw new Error((await this.capabilities()).unavailableReason ?? "Local hardware worker is unavailable."); }
  async launch(_plan: TrainingPlan, _approval: TrainingApproval): Promise<TrainingJob> { throw new Error((await this.capabilities()).unavailableReason ?? "Local hardware worker is unavailable."); }
  async status(_jobId: string): Promise<TrainingJob> { throw new Error("No local hardware job was launched."); }
  async cancel(_jobId: string): Promise<TrainingJob> { throw new Error("No local hardware job was launched."); }
  async collect(_jobId: string): Promise<TrainingArtifact[]> { return []; }
}

export function capabilityReason(id: HardwareDestinationId, inventory: ComputeInventory | null): string {
  if (!inventory) return "Run compute discovery before configuring this local worker.";
  if (id === "local_cuda") {
    if (inventory.host.platform !== "linux") return "The first CUDA worker target requires Linux.";
    if (!inventory.devices.some((device) => device.vendor === "nvidia" && device.kind === "gpu" && device.available)) return "No supported NVIDIA GPU was detected.";
    if (inventory.runtimes.find((runtime) => runtime.kind === "cuda")?.state !== "available") return "An NVIDIA GPU was found, but the CUDA runtime probe did not pass.";
    return "CUDA hardware is compatible, but this machine has no recorded live worker conformance proof yet.";
  }
  if (inventory.host.platform !== "darwin" || inventory.host.architecture !== "arm64") return "The MLX worker requires Apple silicon.";
  if (!inventory.devices.some((device) => device.vendor === "apple" && device.available)) return "No compatible Apple accelerator was detected.";
  if (inventory.runtimes.find((runtime) => runtime.kind === "mlx")?.state !== "available") return "Apple silicon was found, but the pinned MLX runtime probe did not pass.";
  return "MLX hardware is compatible, but this machine has no recorded live worker conformance proof yet.";
}
