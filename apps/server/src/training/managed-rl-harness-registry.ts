import type { TaskDataRecord, Taskset } from "@openpond/contracts";

export type ManagedRlLocalRolloutClaim = {
  schemaVersion: "openpond.managedRlLocalRolloutClaim.v1";
  executionKind: "rollout" | "evaluation";
  executionId: string;
  jobId: string;
  groupId: string | null;
  rolloutId: string | null;
  deliveryId: string;
  policyVersion: number;
  task: { id: string; expectedText: string | null };
  taskset: { id: string; revision: number; contentHash: string };
  harnessRelease: { id: string; contentHash: string };
  reward: { kind: "exact_text_v1" } | { kind: "local_harness_receipt_v1"; environmentId: string };
  environmentSha256: string;
  request: Record<string, unknown>;
  policy: { path: string; token: string };
};

export type ManagedRlHarnessExecutionInput = {
  claim: ManagedRlLocalRolloutClaim;
  taskset: Taskset;
  task: TaskDataRecord;
  harnessRoot: string;
  storeDir: string;
  executorId: string;
  signal: AbortSignal;
  timestamp?: () => string;
  policyRequest(request: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>>;
};

export type ManagedRlHarnessAdapterDescriptor = {
  id: string;
  supports(input: { taskset: Taskset; environmentId: string }): boolean;
  execute(input: ManagedRlHarnessExecutionInput): Promise<Record<string, unknown>>;
};

const adapters: ManagedRlHarnessAdapterDescriptor[] = [];

export function registerManagedRlHarnessAdapter(adapter: ManagedRlHarnessAdapterDescriptor): void {
  if (adapters.some((candidate) => candidate.id === adapter.id)) return;
  adapters.push(adapter);
}

export function resolveManagedRlHarnessAdapter(input: {
  taskset: Taskset;
  environmentId: string;
}): ManagedRlHarnessAdapterDescriptor {
  const matches = adapters.filter((adapter) => adapter.supports(input));
  if (matches.length !== 1) {
    throw new Error(matches.length
      ? `managed_rl_harness_adapter_ambiguous:${matches.map((item) => item.id).join(",")}`
      : `managed_rl_local_harness_unsupported:${input.environmentId}`);
  }
  return matches[0]!;
}

export function supportsManagedRlHarness(taskset: Taskset, placement: string): boolean {
  if (placement !== "local") return false;
  const environmentId = declaredEnvironmentId(taskset);
  return adapters.filter((adapter) => adapter.supports({ taskset, environmentId })).length === 1;
}

export function declaredEnvironmentId(taskset: Taskset): string {
  const explicit = taskset.environment.metadata.runtimeAdapterId;
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  const benchmark = taskset.environment.metadata.benchmark;
  if (benchmark && typeof benchmark === "object" && !Array.isArray(benchmark)) {
    const id = Reflect.get(benchmark, "id");
    if (typeof id === "string" && id.trim()) return id.trim();
  }
  return taskset.environment.entrypoint;
}
