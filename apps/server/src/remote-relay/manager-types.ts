import { z } from "zod";
import type {
  RemoteAccessAccountStatus,
  RemoteDispatchCommand,
  Session,
} from "@openpond/contracts";
import type { SqliteStore } from "../store/store.js";
import type { DeviceInstallation } from "./installation.js";
import type { DeviceLocalOwner } from "./local-scope.js";
import type { createRemoteDeviceClient } from "./client.js";
import type { captureRemoteTaskCatalog } from "./catalog.js";

export type Selected = {
  owner: DeviceLocalOwner;
  credentialKey: string;
  request: Parameters<typeof createRemoteDeviceClient>[0]["request"];
};
export type RemoteRelayDependencies = {
  storeDir: string;
  installation: DeviceInstallation;
  store: SqliteStore;
  current(): Promise<Selected | null>;
  accountStatus(): Promise<RemoteAccessAccountStatus>;
  inspect: Parameters<typeof captureRemoteTaskCatalog>[0]["inspect"];
  execute(
    command: RemoteDispatchCommand,
  ): Promise<import("@openpond/contracts").RemoteCommandReceipt>;
  listen(
    listener: (event: import("@openpond/contracts").RuntimeEvent) => void,
  ): () => void;
  warn(message: string): void;
  outputs(
    session: Session,
  ): Promise<import("@openpond/contracts").FileOutputRef[]>;
  readOutput(
    session: Session,
    outputId: string,
  ): Promise<{
    outputRef: import("@openpond/contracts").FileOutputRef;
    contentsBase64: string;
  }>;
  caller?: {
    needsConnection(): boolean;
    requestAuthority(
      deviceId: string,
      genericRuntimeId: string,
    ): unknown | null;
    receiveOffers(payload: unknown): void;
  };
};

export const Hello = z.object({
  deviceId: z.string(),
  epoch: z.string(),
  fence: z.number().int().positive(),
  grantRevision: z.number().int().positive(),
  leaseExpiresAt: z.string().datetime(),
});
export const Keys = z.object({
  keys: z.array(z.object({ keyId: z.string(), publicKey: z.string() })).max(10),
  artifactUploadOrigins: z.array(z.string().url()).max(10).default([]),
});
