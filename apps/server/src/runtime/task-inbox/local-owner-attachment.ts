import type {
  CodexStatus,
  OpenPondProfileRef,
  OpenPondProfileState,
  ProviderSettings,
  Session,
} from "@openpond/contracts";
import type { loadLocalHarnessRuntimeForSession } from "../../harness/local-profile-workflow-runtime.js";
import {
  DeviceLocalOwnerSchema,
  deviceOwnsLocalSession,
  type DeviceLocalOwner,
} from "../../remote-relay/local-scope.js";
import { localSessionMayResolveOwnership } from "../../remote-relay/session-ownership.js";
import {
  localManagedProviderSupported,
  localManagedSessionId,
} from "./local-managed-identity.js";
import { createLocalManagedReadiness } from "./local-managed-readiness.js";

export type LocalOwnerAttachmentResult = {
  eligible: boolean;
  reason: string | null;
};
export type LocalOwnerAttachmentInspector = (
  session: Session,
) => Promise<LocalOwnerAttachmentResult>;

/** A local human may explicitly claim an unowned task. This projection never reaches storage or the wire. */
export function createLocalOwnerAttachmentInspection(input: {
  owner: DeviceLocalOwner;
  providers: ProviderSettings;
  codexStatus(): Promise<CodexStatus>;
  loadProfile(ref: OpenPondProfileRef): Promise<OpenPondProfileState>;
  loadHarness(
    session: Session,
  ): ReturnType<typeof loadLocalHarnessRuntimeForSession>;
}): LocalOwnerAttachmentInspector {
  const owner = DeviceLocalOwnerSchema.parse(input.owner);
  let codex: Promise<CodexStatus> | undefined;
  const profileChecks = new Map<string, Promise<LocalOwnerAttachmentResult>>();
  const unavailable = (reason: string): LocalOwnerAttachmentResult => ({
    eligible: false,
    reason,
  });
  const readiness = createLocalManagedReadiness({
    configProvider: async (provider) =>
      input.providers.providers[
        provider as keyof typeof input.providers.providers
      ] ?? null,
    codexStatus: async () => {
      const status = await (codex ??= input.codexStatus());
      return {
        enabled: input.providers.providers.codex?.enabled ?? false,
        available: status.available && status.authHealth === "signed_in",
        reason:
          status.authHealth === "signed_in"
            ? null
            : "Sign in to the original local Codex installation before adding this task.",
      };
    },
    // The caller captured this authenticated owner once before building the batch.
    openPondStatus: async (session) =>
      deviceOwnsLocalSession(session, owner)
        ? { available: true, reason: null }
        : { available: false, reason: "The selected local account changed." },
  });

  async function profileAvailable(
    session: Session,
  ): Promise<LocalOwnerAttachmentResult> {
    if (
      !session.currentProfile &&
      !session.profileWorkflowBinding &&
      !session.profileComponentBinding
    )
      return { eligible: true, reason: null };
    const key = JSON.stringify([
      session.currentProfile ?? null,
      session.profileWorkflowBinding ?? null,
      session.profileComponentBinding ?? null,
    ]);
    let check = profileChecks.get(key);
    if (!check) {
      check = (async () => {
        try {
          if (
            session.profileWorkflowBinding ||
            session.profileComponentBinding
          ) {
            const runtime = await input.loadHarness(session);
            if (
              !runtime ||
              (session.profileWorkflowBinding && !runtime.workflow)
            )
              return unavailable(
                "The task's original released Profile workflow or component is unavailable.",
              );
          } else if (session.currentProfile) {
            const profile = await input.loadProfile(session.currentProfile);
            if (
              profile.mode !== "local" ||
              profile.activeProfile !== session.currentProfile.profileId ||
              profile.error ||
              profile.setupGate.status !== "ready"
            )
              return unavailable(
                "Restore this task's original Profile and complete its setup before adding it.",
              );
          }
          return { eligible: true, reason: null };
        } catch {
          return unavailable(
            "The task's original Profile or released workflow could not be loaded.",
          );
        }
      })();
      profileChecks.set(key, check);
    }
    return check;
  }

  return async (session) => {
    if (!localSessionMayResolveOwnership(session))
      return unavailable(
        "Only an eligible local task without an existing account owner can be added.",
      );
    if (
      !localManagedProviderSupported(session.provider) ||
      !localManagedSessionId(session)
    )
      return unavailable(
        "This conversation has no qualified original managed session.",
      );
    const projected = {
      ...session,
      metadata: { ...session.metadata, ponderLocalOwner: owner },
    };
    let ready: Awaited<ReturnType<typeof readiness>>;
    try {
      ready = await readiness(projected);
    } catch {
      return unavailable("The original managed provider is unavailable.");
    }
    if (!ready.available)
      return unavailable(
        ready.reason ?? "The original managed provider is unavailable.",
      );
    return profileAvailable(session);
  };
}
