import { createConversationServingOwner } from "./conversation-serving-owner.js";
import { createTrainingActivityAuthorityResolver } from "./resolve-training-activity-authority.js";
import { createTrainingService } from "./training-service.js";
import { createModelProjectHostingService } from "./model-project-hosting.js";
import { managedRlOperatorAccess } from "./managed-rl-operator-access.js";
import { createDatasetStorageService } from "./dataset-storage-service.js";
import { createPortableTrainingServerDependencies } from "./portable-training-server-dependencies.js";
import { createManagedAdapterRegistryClient } from "./managed-adapter-registry-client.js";
import { createManagedAdapterSyncService } from "./managed-adapter-sync-service.js";
import { createManagedAdapterChatRuntime } from "./managed-adapter-chat-runtime.js";
import { createManagedAdapterHostedChatStream } from "./managed-adapter-chat-stream.js";
import { createLocalAdapterPublicationService } from "./local-adapter-publication.js";

type TrainingDependencies = Parameters<typeof createTrainingService>[0];
type CompositionDependencies = Pick<TrainingDependencies,
  "store" | "storeDir" | "resolveReleasedHarness" | "resolveTasksetRelease" |
  "gradeTaskAttempt" | "projectDatasetArtifact" | "resolveDatasetTask" | "tasksetWorkRuntime"
> & {
  resolveAccess: Parameters<typeof createTrainingActivityAuthorityResolver>[0]["access"];
  resolveWorkspaceAccess(): Promise<{ apiBaseUrl: string; token: string; teamId: string; actorId: string }>;
  resolveWorkspaceActor(): Promise<string>;
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
    return deps.resolveWorkspaceAccess();
  };
  const modelProjectHosting = createModelProjectHostingService({
    store, resolveAccess: deps.resolveWorkspaceAccess, resolveActorId: deps.resolveWorkspaceActor,
    resolveReleasedHarness: deps.resolveReleasedHarness, env: process.env,
  });
  const localAdapterPublication = createLocalAdapterPublicationService({ store, home: storeDir, resolveAccess: deps.resolveWorkspaceAccess });
  const trainingService = createTrainingService({
    ...deps,
    ...createPortableTrainingServerDependencies({ storeDir, environment: process.env }),
    resolveActivityAuthority: createTrainingActivityAuthorityResolver({
      access: deps.resolveAccess,
      identity: async () => {
        const { actorId, teamId } = await deps.resolveWorkspaceAccess();
        return { actorId, teamId };
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
  const managedAdapterChatRuntime = createManagedAdapterChatRuntime({store, client: registry, resolveSelectedTeamId: async () => await deps.defaultTeam() ?? null});
  const streamSelectedOpenPondChatTurn = createManagedAdapterHostedChatStream({
    managed: managedAdapterChatRuntime, hosted: deps.streamHosted,
  });
  const conversationServingOwner = createConversationServingOwner({
    store, training: trainingService, hosting: modelProjectHosting, synchronization: managedAdapterSyncService, registry,
    resolveAccess: deps.resolveWorkspaceAccess,
  });
  conversationServingOwner.start();
  deps.onStartupFailure(() => conversationServingOwner.close());
  managedAdapterSyncService.start();
  return {datasetStorageService, datasetStoragePayload, modelProjectHosting, localAdapterPublication,
    trainingService, conversationServingOwner, managedAdapterSyncService, managedAdapterChatRuntime,
    streamSelectedOpenPondChatTurn};
}
