import { createHash, randomUUID } from "node:crypto";
import {
  PonderDesktopProofSchema,
  PonderDesktopScopeSchema,
  ponderDesktopProofMessage,
  ponderDesktopRequestContent,
  type PonderDesktopProof,
  type PonderDesktopScope,
} from "@openpond/contracts";
import type { PonderInstallation } from "./ponder-installation.js";
import type { PonderLocalOwner } from "./ponder-local-scope.js";
import type { createCapturedOpenPondPublicApiClient } from "./sandboxes.js";

type CapturedClient = ReturnType<typeof createCapturedOpenPondPublicApiClient>;

/** One client owns one captured login/team. Neither renderer input nor a later login can replace it. */
export function createPonderDesktopClient(input: {
  installation: PonderInstallation;
  owner: PonderLocalOwner;
  client: CapturedClient;
  binding: { bindingId: string; bindingRevision: number; ownerUserId: string; teamId: string };
}) {
  const { installation, owner, client, binding } = input;
  if (
    !owner.teamId ||
    binding.ownerUserId !== owner.ownerUserId ||
    binding.teamId !== owner.teamId ||
    owner.installationId !== installation.installationId ||
    owner.audience !== client.audience
  ) {
    throw new Error("ponder_desktop_owner_scope_invalid");
  }
  const scope: PonderDesktopScope = PonderDesktopScopeSchema.parse({
    installationId: installation.installationId,
    profileId: owner.profileId,
    ownerUserId: owner.ownerUserId,
    teamId: owner.teamId,
    bindingId: binding.bindingId,
    bindingRevision: binding.bindingRevision,
  });
  const runtimeId = randomUUID();
  function proof(path: string, payload: unknown, epoch: string | null): PonderDesktopProof {
    const unsigned = {
      version: 1 as const,
      scope,
      epoch,
      runtimeId,
      audience: client.audience,
      nonce: randomUUID(),
      issuedAt: new Date().toISOString(),
      payloadHash: createHash("sha256")
        .update(ponderDesktopRequestContent("POST", path, payload))
        .digest("hex"),
    };
    return PonderDesktopProofSchema.parse({
      ...unsigned,
      signature: installation.sign(ponderDesktopProofMessage(unsigned)),
    });
  }
  return {
    scope,
    runtimeId,
    // This is used only by the server's admitted human-turn route, never exposed as a signing endpoint.
    proof,
    request(
      action:
        | "attach"
        | "renew"
        | "catalog-page"
        | "revoke"
        | "poll"
        | "claim"
        | "admission"
        | "attention"
        | "result"
        | "inspection",
      payload: unknown,
      epoch: string | null,
    ) {
      const path = `/ponder/desktop/${action}`;
      return client.request({
        path,
        method: "POST",
        body: { proof: proof(path, payload, epoch), payload },
      });
    },
  };
}
