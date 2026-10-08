import type {
  AppPreferences,
  Approval,
  ChatProvider,
  CodexStatus,
  ProviderSettings,
  Session,
  Turn,
  OpenPondProfileRef,
  OpenPondProfileState,
} from "@openpond/contracts";
import { createPonderActivityBridge } from "../../openpond/ponder-activity-bridge.js";
import { requestHostedPonder } from "../../openpond/ponder-pal.js";
import { createCapturedOpenPondPublicApiClient } from "../../openpond/sandboxes.js";
import { requestConversationLearning } from "../../openpond/conversation-learning.js";
import type { TurnRunner } from "../turns/ports.js";
import { createLocalManagedMessaging } from "./local-managed-messaging.js";
import { createOpenPondManagedReadiness } from "./openpond-managed-readiness.js";
import { createLocalManagedReadiness } from "./local-managed-readiness.js";
import type { TaskInboxRepository } from "./repository.js";
import type { DeviceLocalOwner } from "../../remote-relay/local-scope.js";
import type { loadLocalHarnessRuntimeForSession } from "../../harness/local-profile-workflow-runtime.js";
import { createLocalOwnerAttachmentInspection } from "./local-owner-attachment.js";

/** Authenticated account routes; the owner retains startup/recovery/shutdown. */
export function createDesktopManagedAgentRoutes(deps: {
  store: TaskInboxRepository & {
    getSession(id: string): Promise<Session | null>;
    latestTurnForSession(id: string): Promise<Turn | null>;
    pendingApprovals(): Promise<Approval[]>;
  };
  getSession(id: string): Promise<Session>;
  turnRunner: Pick<TurnRunner, "admitUserLocalMessage">;
  localByokRuntimeState(): Promise<{ settings: ProviderSettings }>;
  refreshCodexStatus(): Promise<CodexStatus>;
  loadAppPreferences(): Promise<AppPreferences>;
  loadProfile(ref: OpenPondProfileRef): Promise<OpenPondProfileState>;
  loadHarness(
    session: Session,
  ): ReturnType<typeof loadLocalHarnessRuntimeForSession>;
}) {
  const localManagedMessaging = createLocalManagedMessaging({
    store: deps.store,
    getSession: async (id) =>
      (await deps.store.getSession(id)) ? deps.getSession(id) : null,
    latestTurn: (id) => deps.store.latestTurnForSession(id),
    approvalBlocked: async (id) => {
      const turn = await deps.store.latestTurnForSession(id);
      return (
        turn?.status === "in_progress" &&
        (await deps.store.pendingApprovals()).some(
          (approval) =>
            approval.sessionId === id &&
            !!approval.turnId &&
            (approval.turnId === turn.id ||
              approval.turnId === turn.providerTurnId),
        )
      );
    },
    readiness: createLocalManagedReadiness({
      openPondStatus: createOpenPondManagedReadiness(deps.loadAppPreferences),
      configProvider: async (provider) =>
        (await deps.localByokRuntimeState()).settings.providers[
          provider as ChatProvider
        ] ?? null,
      codexStatus: async () => {
        const status = await deps.refreshCodexStatus();
        const config = (await deps.localByokRuntimeState()).settings.providers
          .codex;
        return {
          enabled: config?.enabled ?? false,
          available: status.available && status.authHealth === "signed_in",
          reason:
            status.authHealth === "signed_in"
              ? null
              : "Sign in to the original local Codex installation before sending.",
        };
      },
    }),
    admit: (input) => deps.turnRunner.admitUserLocalMessage(input),
  });
  return {
    localManagedMessaging,
    prepareOwnerAttachment: async (owner: DeviceLocalOwner) =>
      createLocalOwnerAttachmentInspection({
        owner,
        providers: structuredClone(
          (await deps.localByokRuntimeState()).settings,
        ),
        codexStatus: deps.refreshCodexStatus,
        loadProfile: deps.loadProfile,
        loadHarness: deps.loadHarness,
      }),
    conversationLearningRequestPayload: requestConversationLearning,
    ponderRequestPayload: async (
      request: Parameters<typeof requestHostedPonder>[0],
    ) =>
      requestHostedPonder({
        ...request,
        teamId: (await deps.loadAppPreferences()).defaultTeamId ?? undefined,
      }),
  };
}

/** Shares current account resolution with the hosted route without owning its lifecycle. */
export function createDesktopPonderActivityBridge(
  deps: Omit<
    Parameters<typeof createPonderActivityBridge>[0],
    "teamId" | "request"
  > & {
    loadAppPreferences(): Promise<AppPreferences>;
  },
) {
  const { loadAppPreferences, ...bridge } = deps;
  return createPonderActivityBridge({
    ...bridge,
    teamId: async () => (await loadAppPreferences()).defaultTeamId,
    request: async (request, context, teamId) =>
      createCapturedOpenPondPublicApiClient(context, teamId).request(request),
  });
}
