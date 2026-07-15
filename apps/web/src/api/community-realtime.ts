import {
  CommunityEventSchema,
  type CommunityEvent,
  type CommunityRealtimeSession,
} from "@openpond/contracts";
import {
  openManagedEventSocket,
  type ManagedEventSocketOptions,
  type ManagedEventWebSocketFactory,
} from "./managed-event-websocket";

export type CommunityRealtimeHandle = { close(): void };

export function openCommunityRealtime(
  input: {
    session: CommunityRealtimeSession;
    onEvent: (event: CommunityEvent) => void;
    onReady?: () => void;
    onError?: (error: unknown) => void;
  },
  webSocketFactory?: ManagedEventWebSocketFactory,
  options?: ManagedEventSocketOptions,
): CommunityRealtimeHandle {
  return openManagedEventSocket(
    {
      realtimeUrl: input.session.realtimeUrl,
      httpUrl: input.session.httpUrl,
      authorizationToken: input.session.token,
      channels: [input.session.channel],
      onEvent: (value) => {
        const parsed = CommunityEventSchema.safeParse(value);
        if (parsed.success) input.onEvent(parsed.data);
      },
      onReady: input.onReady,
      onError: input.onError,
    },
    webSocketFactory,
    options,
  );
}
