import type {
  ConnectedAppConnectionLike,
  MentionedConnectedAppRef,
  RuntimeEvent,
  Session,
} from "@openpond/contracts";
import type { SandboxIntegrationConnectionStatusFilter } from "@openpond/cloud";
import {
  connectedAppProviderToolNames,
} from "../../openpond/connected-app-tool-registry.js";
import {
  mentionedConnectedAppRefsFromPrompt,
  promptMentionsConnectedAppProvider,
  resolveMentionedConnectedAppContexts,
  type ResolvedConnectedAppContext,
} from "../../openpond/connected-app-context.js";
import { event, textFromUnknown } from "../../utils.js";

export type ConnectedAppIntegrationConnectionLookup = (input: {
  teamId?: string;
  status?: SandboxIntegrationConnectionStatusFilter;
}) => Promise<{
  teamId: string | null;
  connections: ConnectedAppConnectionLike[];
}>;

export async function resolveConnectedAppContextsForTurn(input: {
  refs: MentionedConnectedAppRef[] | undefined;
  prompt?: string | null;
  cloudTeamId?: string | null;
  listIntegrationConnections: ConnectedAppIntegrationConnectionLookup;
}): Promise<ResolvedConnectedAppContext[]> {
  const explicitRefs = input.refs ?? [];
  if (explicitRefs.length === 0 && !promptMentionsConnectedAppProvider(input.prompt)) return [];
  const cloudTeamId = input.cloudTeamId?.trim() ?? "";
  const primaryResult = await input.listIntegrationConnections({
    ...(cloudTeamId ? { teamId: cloudTeamId } : {}),
    status: "active",
  });
  const primaryRefs = explicitRefs.length > 0
    ? explicitRefs
    : mentionedConnectedAppRefsFromPrompt({
        prompt: input.prompt,
        connections: primaryResult.connections,
      });
  const primaryContexts = withConnectedAppToolNames(
    resolveMentionedConnectedAppContexts({
      mentionedRefs: primaryRefs,
      connections: primaryResult.connections,
    }),
  );
  if (!cloudTeamId || (primaryRefs.length > 0 && mentionedConnectedAppRefsResolved(primaryRefs, primaryContexts))) {
    return primaryContexts;
  }

  try {
    const aggregateResult = await input.listIntegrationConnections({ status: "active" });
    const aggregateRefs = explicitRefs.length > 0
      ? explicitRefs
      : mentionedConnectedAppRefsFromPrompt({
          prompt: input.prompt,
          connections: aggregateResult.connections,
        });
    const aggregateContexts = withConnectedAppToolNames(
      resolveMentionedConnectedAppContexts({
        mentionedRefs: aggregateRefs,
        connections: aggregateResult.connections,
      }),
    );
    return aggregateContexts.length > 0 ? aggregateContexts : primaryContexts;
  } catch (error) {
    if (primaryContexts.length > 0) return primaryContexts;
    throw error;
  }
}

export function createConnectedAppTurnResolver(deps: {
  listIntegrationConnections?: ConnectedAppIntegrationConnectionLookup;
  appendRuntimeEvent(runtimeEvent: RuntimeEvent): Promise<void>;
}) {
  return async function connectedAppsForTurn(input: {
    refs: MentionedConnectedAppRef[] | undefined;
    prompt: string;
    session: Session;
    turnId: string;
  }): Promise<ResolvedConnectedAppContext[]> {
    if (!deps.listIntegrationConnections || (
      (!input.refs || input.refs.length === 0) && !promptMentionsConnectedAppProvider(input.prompt)
    )) return [];
    try {
      return await resolveConnectedAppContextsForTurn({
        refs: input.refs,
        prompt: input.prompt,
        cloudTeamId: input.session.cloudTeamId,
        listIntegrationConnections: deps.listIntegrationConnections,
      });
    } catch (error) {
      await deps.appendRuntimeEvent(event({
        sessionId: input.session.id,
        turnId: input.turnId,
        name: "diagnostic",
        source: "server",
        appId: input.session.appId,
        status: "failed",
        output: "Connected app references could not be resolved for this turn.",
        data: {
          kind: "connected_app_resolution",
          providerCount: input.refs?.length ?? 0,
          error: textFromUnknown(error) || "Unknown connected app resolution error.",
        },
      }));
      return [];
    }
  };
}

function withConnectedAppToolNames(
  contexts: ResolvedConnectedAppContext[],
): ResolvedConnectedAppContext[] {
  return contexts.map((context) => ({
    ...context,
    toolNames: Array.from(
      new Set([
        ...context.toolNames,
        "connected_app_skill_read",
        ...connectedAppProviderToolNames(context),
      ]),
    ),
  }));
}

function mentionedConnectedAppRefsResolved(
  refs: MentionedConnectedAppRef[],
  contexts: ResolvedConnectedAppContext[],
): boolean {
  const resolvedProviders = new Set(contexts.map((context) => context.provider));
  return refs.every((ref) => resolvedProviders.has(ref.provider));
}
