import type { RemoteAccessConnectionState } from "@openpond/contracts";

export type RemoteConnectionFailure = {
  state: RemoteAccessConnectionState;
  reason: string;
  minimumSupportedProtocolVersion?: number;
};

/** Public reason codes only; transport errors may contain private request details. */
export function remoteCloseFailure(
  code: number,
  reason: string,
): RemoteConnectionFailure {
  if (code === 4006 || reason.startsWith("protocol_unsupported")) {
    const minimum = /minimum=(\d+)/.exec(reason);
    return {
      state: "update_required",
      reason: "protocol_unsupported",
      ...(minimum
        ? { minimumSupportedProtocolVersion: Number(minimum[1]) }
        : {}),
    };
  }
  if (["grant_revoked", "remote_access_off", "ticket_revoked"].includes(reason))
    return { state: "off", reason };
  if (["authentication_required", "ticket_invalid"].includes(reason))
    return { state: "reconnecting", reason: "authentication_expired" };
  return {
    state: "reconnecting",
    reason: code === 1013 ? "relay_backpressure" : "connection_lost",
  };
}

/** Every retry begins within six seconds, with bounded jitter and no retry storm. */
export function remoteReconnectDelay(attempt: number): number {
  const base = Math.min(5_000, 250 * 2 ** Math.min(attempt, 5));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}
