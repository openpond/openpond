import {
  TeamChatEventSchema,
  type TeamChatEvent,
  type TeamChatRealtimeSession,
} from "@openpond/contracts";
import {
  openManagedEventSocket,
  type ManagedEventWebSocketFactory,
} from "./managed-event-websocket";

export type TeamChatRealtimeHandle = {
  close(): void;
};

export function openTeamChatRealtime(
  input: {
    session: TeamChatRealtimeSession;
    threadIds: string[];
    onEvent: (event: TeamChatEvent) => void;
    onReady?: () => void;
    onError?: (error: unknown) => void;
  },
  webSocketFactory?: ManagedEventWebSocketFactory,
): TeamChatRealtimeHandle {
  const channels = [
    `/team-chat/users/${input.session.userId}/${input.session.teamId}`,
    ...Array.from(new Set(input.threadIds)).map((threadId) => `/team-chat/threads/${threadId}`),
  ];
  return openManagedEventSocket(
    {
      realtimeUrl: input.session.realtimeUrl,
      httpUrl: input.session.httpUrl,
      authorizationToken: input.session.token,
      channels,
      onEvent: (value) => {
        const parsed = TeamChatEventSchema.safeParse(value);
        if (parsed.success) input.onEvent(parsed.data);
      },
      onReady: input.onReady,
      onError: input.onError,
    },
    webSocketFactory,
  );
}
