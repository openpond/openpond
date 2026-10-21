import type { RemoteDevice } from "./remote-device.js";

export type RemoteAccessConnectionState =
  | "signed_out"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "offline"
  | "off"
  | "update_required";
export type RemoteAccessAccountStatus = {
  state: "signed_out" | "ready";
  account: { id: string; label: string } | null;
  team: { id: string } | null;
  webBaseUrl: string | null;
};
export type RemoteAccessSettingsStatus = {
  state: RemoteAccessConnectionState;
  enabled: boolean;
  owner: { ownerUserId: string; teamId: string | null } | null;
  account: RemoteAccessAccountStatus["account"];
  team: RemoteAccessAccountStatus["team"];
  webBaseUrl: string | null;
  reason: string | null;
  minimumSupportedProtocolVersion: number | null;
  supportedProtocolVersion: number;
  device: RemoteDevice | null;
  devices: RemoteDevice[];
  ponder?: { coordinatorId: string; sessionId: string | null; revision: number; enabled: boolean; canPublish: boolean } | null;
  unresolvedTasks: { id: string; title: string; revision: string }[];
};
export type RemoteAccessSettingsAction =
  | "status"
  | "enable"
  | "disable"
  | "retry"
  | "attach"
  | "publish-ponder"
  | "unpublish-ponder"
  | "rename"
  | "remove"
  | "disable-device";
