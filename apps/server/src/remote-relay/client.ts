import { createHash, randomUUID } from "node:crypto";
import { remoteDeviceCanonicalContent, remoteDeviceProofMessage, type RemoteDeviceScope } from "@openpond/contracts";
import type { DeviceInstallation } from "./installation.js";

export function createRemoteDeviceClient(input: {
  installation: DeviceInstallation; scope: RemoteDeviceScope; audience: string;
  request(params: { path: string; method?: "GET" | "POST" | "PATCH" | "DELETE"; body?: Record<string, unknown> }): Promise<unknown>;
}) {
  const runtimeId = randomUUID();
  return {
    runtimeId,
    request: input.request,
    signed(path: string, payload: Record<string, unknown>) {
      const unsigned = { version: 1 as const, scope: input.scope, runtimeId, audience: input.audience,
        nonce: randomUUID(), issuedAt: new Date().toISOString(),
        payloadHash: createHash("sha256").update(remoteDeviceCanonicalContent({ method: "POST", path, payload })).digest("hex") };
      return input.request({ path: path.replace(/^\/v1/, ""), method: "POST", body: { payload,
        proof: { ...unsigned, signature: input.installation.sign(remoteDeviceProofMessage(unsigned)) } } });
    },
  };
}

export function createSelectedRemoteClient(installation: import("./installation.js").DeviceInstallation, current: import("./manager-types.js").Selected) {
    return createRemoteDeviceClient({
      installation: installation,
      scope: {
        installationId: current.owner.installationId,
        profileId: current.owner.profileId,
        ownerUserId: current.owner.ownerUserId,
        teamId: current.owner.teamId,
      },
      audience: current.owner.audience,
      request: current.request,
    });
  }
