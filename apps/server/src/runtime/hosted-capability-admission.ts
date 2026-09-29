import type { HostStorageCapability } from "@openpond/agent-runtime";

/** Every operation used by the admitted hosted Work composition. */
export const HOSTED_WORK_REQUIRED_OPERATIONS = [
  "sandbox/request", "embedding/authorize",
  "output/begin", "output/chunk", "output/complete", "output/saveSandboxFile",
  "settings/get", "harness/get", "harness/overlay/get", "harness/overlay/put",
  "harness/memory/get", "harness/memory/list", "harness/memory/search", "harness/memory/write",
  "harness/state/read", "task-inbox/execute", "create-improve/execute",
  "approval/get", "approval/upsert", "usage/getByRequestId", "usage/upsert", "usage/page",
  "session/count", "session/get", "session/page", "session/put",
  "turn/count", "turn/wakeCount", "turn/get", "turn/put", "turn/latest", "turn/page",
  "thread/turnPage", "event/append", "events/page", "events/latestAssistantText",
] as const satisfies readonly HostStorageCapability["operations"][number][];

export function assertHostedWorkCapabilities(capabilities: HostStorageCapability): void {
  if (HOSTED_WORK_REQUIRED_OPERATIONS.some((operation) => !capabilities.operations.includes(operation))) {
    throw new Error("Hosted Postgres runtime capabilities are incomplete.");
  }
  // These are the private client's hard bounds. A host advertising smaller
  // limits would reject otherwise valid child writes or concurrent turn reads.
  if (capabilities.maxRequestBytes < 256_000 || capabilities.maxInFlight < 32 ||
      capabilities.maxPageSize < 200) {
    throw new Error("Hosted Postgres runtime transport limits are incompatible.");
  }
}
