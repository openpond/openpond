import type { RemoteDevice } from "./remote-device.js";

export type RemoteAccessConnectionState =
  | "signed_out"
  | "workspace_required"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "offline"
  | "off"
  | "update_required";
export type RemoteAccessAccountStatus = {
  state: "signed_out" | "workspace_required" | "ready";
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
  unresolvedTasks: { id: string; title: string; revision: string }[];
};
export type RemoteAccessSettingsAction =
  | "status"
  | "enable"
  | "disable"
  | "retry"
  | "attach"
  | "rename"
  | "remove"
  | "disable-device";
