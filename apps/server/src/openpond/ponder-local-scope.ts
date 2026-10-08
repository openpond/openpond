import { createHash } from "node:crypto";
import { z } from "zod";
import type { Session } from "@openpond/contracts";
import type { RuntimeAccountContext } from "@openpond/runtime";

export const PonderLocalOwnerSchema = z
  .object({
    version: z.literal(1),
    installationId: z.string().uuid(),
    profileId: z.string().min(1).max(200),
    ownerUserId: z.string().min(1).max(200),
    teamId: z.string().min(1).max(200).nullable(),
    audience: z.string().url(),
  })
  .strict();
export type PonderLocalOwner = z.infer<typeof PonderLocalOwnerSchema>;

/** Login ownership and agent Prompt/Profile selection are distinct identities. */
export function ponderLocalOwner(
  context: RuntimeAccountContext,
  installationId: string,
  teamId: string | null,
  audience: string,
): PonderLocalOwner | null {
  const account = context.accountState;
  if (
    account.state !== "signed_in" ||
    !account.activeProfile ||
    !account.profile?.id ||
    !context.token
  )
    return null;
  return PonderLocalOwnerSchema.parse({
    version: 1,
    installationId,
    profileId: createHash("sha256")
      .update(
        JSON.stringify([
          account.activeProfile.handle,
          account.activeProfile.baseUrl ?? account.baseUrl,
          audience,
        ]),
      )
      .digest("hex"),
    ownerUserId: account.profile.id,
    teamId,
    audience,
  });
}

export function ponderOwnsLocalSession(session: Session, owner: PonderLocalOwner): boolean {
  const stored = PonderLocalOwnerSchema.safeParse(session.metadata?.ponderLocalOwner);
  if (!stored.success || !owner.teamId) return false;
  return (
    stored.data.installationId === owner.installationId &&
    stored.data.profileId === owner.profileId &&
    stored.data.ownerUserId === owner.ownerUserId &&
    stored.data.teamId === owner.teamId &&
    stored.data.audience === owner.audience
  );
}

/** Public session metadata cannot transfer another login's local ownership. */
export function publicSessionMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const {
    ponderLocalOwner: _owner,
    ponderDesktopReservation: _reservation,
    ponderWorkspaceRevision: _workspace,
    ...ordinary
  } = metadata ?? {};
  return ordinary;
}

export function preservePonderSessionIdentity(
  existing: Session["metadata"],
  metadata: Record<string, unknown> | undefined,
) {
  return {
    ...publicSessionMetadata(metadata),
    ...(existing?.ponderLocalOwner !== undefined
      ? { ponderLocalOwner: existing.ponderLocalOwner }
      : {}),
    ...(existing?.ponderDesktopReservation !== undefined
      ? { ponderDesktopReservation: existing.ponderDesktopReservation }
      : {}),
    ...(existing?.ponderWorkspaceRevision !== undefined
      ? { ponderWorkspaceRevision: existing.ponderWorkspaceRevision }
      : {}),
  };
}
