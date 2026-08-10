import { TrainingExecutionRefSchema, type TrainingCatalog, type TrainingJob } from "@openpond/contracts";
import { TrainingAdapterRegistry, type TrainingDestinationRegistry } from "@openpond/training-sdk";
import type { SqliteStore } from "../store/store.js";
import { OpenPondManagedTrainingAdapter } from "./openpond-managed-training-adapter.js";

export function createDestinationTrainingEngineRegistry(input: {
  destinations: TrainingDestinationRegistry;
  store: SqliteStore;
  storeDir: string;
  resolveManagedAccess?: () => Promise<{ apiBaseUrl: string; token: string; teamId: string }>;
  catalog(): Promise<TrainingCatalog>;
}) {
  const adapters = new TrainingAdapterRegistry() as TrainingAdapterRegistry & {
    close(): Promise<void>;
    refreshManagedEvidence(job: TrainingJob): Promise<void>;
  };
  const managed = new OpenPondManagedTrainingAdapter({
    store: input.store,
    storeDir: input.storeDir,
    resolveAccess: input.resolveManagedAccess,
  });
  adapters.registerEngine(managed);
  adapters.close = () => managed.close();
  adapters.refreshManagedEvidence = async (job) => {
    const parsed = TrainingExecutionRefSchema.safeParse(job.metadata.portableExecutionRef);
    if (parsed.success && parsed.data.adapterId === "sandbox-managed-rl") {
      await managed.refreshEvidence(parsed.data);
    }
  };
  return adapters;
}
