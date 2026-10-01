import { createTrainingActivityAuthorityResolver } from "./resolve-training-activity-authority.js";
import { createTrainingService } from "./training-service.js";
import { createModelProjectHostingService } from "./model-project-hosting.js";
import { managedRlOperatorAccess } from "./managed-rl-operator-access.js";
import { createDatasetStorageService } from "./dataset-storage-service.js";
import { createPortableTrainingServerDependencies } from "./portable-training-server-dependencies.js";
import { createManagedAdapterRegistryClient } from "./managed-adapter-registry-client.js";
import { resolveManagedAdapterUserAccess } from "../openpond/hosted-api-access.js";
import { createManagedAdapterSyncService } from "./managed-adapter-sync-service.js";
import { createManagedAdapterChatRuntime } from "./managed-adapter-chat-runtime.js";
import { createManagedAdapterHostedChatStream } from "./managed-adapter-chat-stream.js";

type TrainingDependencies = Parameters<typeof createTrainingService>[0];
type CompositionDependencies = Pick<TrainingDependencies,
  "store" | "storeDir" | "resolveReleasedHarness" | "resolveTasksetRelease" |
  "gradeTaskAttempt" | "projectDatasetArtifact" | "resolveDatasetTask" | "tasksetWorkRuntime"
> & {
  resolveAccess: Parameters<typeof createTrainingActivityAuthorityResolver>[0]["access"];
  account(): Promise<{state: string; profile?: {id: string | null; handle?: string | null} | null}>;
  defaultTeam(): Promise<string | null | undefined>;
  streamHosted: Parameters<typeof createManagedAdapterHostedChatStream>[0]["hosted"];
  onStartupFailure(close: () => unknown): void;
};

/** Keep managed model synchronization, current authority, and startup ownership
 * together while the entry point composes the wider application. */
export function createManagedTrainingComposition(deps: CompositionDependencies) {
  const { store, storeDir } = deps;
  const datasetStorageService = createDatasetStorageService({ storeDir });
  const registry = createManagedAdapterRegistryClient();
  const managedAdapterSyncService = createManagedAdapterSyncService({
    store, client: registry, resolveSelectedTeamId: async () => await deps.defaultTeam() ?? null,
  });
  deps.onStartupFailure(() => managedAdapterSyncService.close());
  const datasetStoragePayload = async (action: "state" | "update", payload?: unknown) =>
    action === "state" ? datasetStorageService.state() : datasetStorageService.update(payload);
  const resolveManagedTrainingAccess = async () => {
    const operatorAccess = await managedRlOperatorAccess(process.env);
    if (operatorAccess) return operatorAccess;
    return resolveManagedAdapterUserAccess({ teamId: await deps.defaultTeam() });
  };
  const actorId = async () => {
    const account = await deps.account();
    if (account.state !== "signed_in" || !account.profile?.id)
      throw new Error("Sign in to retain evaluation operation recovery.");
    return account.profile.id;
  };
  const modelProjectHosting = createModelProjectHostingService({
    store, resolveAccess: resolveManagedTrainingAccess, resolveActorId: actorId,
    resolveReleasedHarness: deps.resolveReleasedHarness, env: process.env,
  });
  const trainingService = createTrainingService({
    ...deps,
    ...createPortableTrainingServerDependencies({ storeDir, environment: process.env }),
    resolveActivityAuthority: createTrainingActivityAuthorityResolver({
      access: deps.resolveAccess,
      identity: async () => {
        const account = await deps.account(), teamId = (await deps.defaultTeam())?.trim();
        if (account.state !== "signed_in" || !account.profile?.id || !teamId)
          throw new Error("Sign in and select a workspace before starting training.");
        return {actorId: account.profile.id, teamId};
      },
    }),
    resolveManagedTrainingAccess,
    resolveApprovalActor: async () => {
      const account = await deps.account();
      return account.state === "signed_in" ? account.profile?.handle?.trim() || null : null;
    },
    deactivateManagedBinding: managedAdapterSyncService.deactivateBinding,
    reactivateManagedBinding: managedAdapterSyncService.reactivateBinding,
    activateManagedBinding: managedAdapterSyncService.activateBinding,
  });
  deps.onStartupFailure(() => trainingService.close());
  const managedAdapterChatRuntime = createManagedAdapterChatRuntime({store, client: registry});
  const streamSelectedOpenPondChatTurn = createManagedAdapterHostedChatStream({
    managed: managedAdapterChatRuntime, hosted: deps.streamHosted,
  });
  managedAdapterSyncService.start();
  return {datasetStorageService, datasetStoragePayload, modelProjectHosting,
    trainingService, managedAdapterSyncService, managedAdapterChatRuntime,
    streamSelectedOpenPondChatTurn};
}
