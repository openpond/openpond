import { createHash } from "node:crypto";
import { z } from "zod";
import {
  PonderDesktopAttachmentSchema,
  PonderDesktopProjectAuthoritySchema,
  PONDER_DESKTOP_CATALOG_MAX_TARGETS,
} from "@openpond/contracts";
import { PonderLocalOwnerSchema, type PonderLocalOwner } from "../openpond/ponder-local-scope.js";
import { PonderProjectSnapshotSchema } from "../openpond/ponder-project-snapshot.js";
import type { OpenPondSqliteConnection } from "./sqlite/sqlite-driver.js";

export const PonderProjectSharingAuthoritySchema = PonderDesktopProjectAuthoritySchema;
export type PonderProjectSharingAuthority = z.infer<typeof PonderProjectSharingAuthoritySchema>;
export const PonderProjectSharingSchema = z
  .object({
    revision: z.number().int().positive(),
    owner: PonderLocalOwnerSchema,
    authority: PonderProjectSharingAuthoritySchema,
    project: PonderProjectSnapshotSchema,
    shared: z.boolean(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type PonderProjectSharing = z.infer<typeof PonderProjectSharingSchema>;
export const PonderProjectSharingInputSchema = PonderProjectSharingSchema.omit({ revision: true });
export type PonderProjectSharingInput = z.infer<typeof PonderProjectSharingInputSchema>;
const ownerKey = (owner: PonderLocalOwner) =>
  createHash("sha256")
    .update(JSON.stringify(PonderLocalOwnerSchema.parse(owner)))
    .digest("hex");

function assertAuthority(
  db: OpenPondSqliteConnection,
  owner: PonderLocalOwner,
  expected: PonderProjectSharingAuthority,
) {
  const parsedOwner = PonderLocalOwnerSchema.parse(owner);
  const authority = PonderProjectSharingAuthoritySchema.parse(expected);
  const row = db.get<{ payload: string }>(
    "SELECT payload FROM ponder_desktop_authority WHERE id = 1",
  );
  const actual = row ? PonderDesktopAttachmentSchema.parse(JSON.parse(row.payload)) : null;
  if (
    !actual ||
    actual.state !== "attached" ||
    Date.parse(actual.leaseExpiresAt) <= Date.now() ||
    actual.authorizationRevision !== authority.authorizationRevision ||
    !Object.entries(authority.scope).every(
      ([key, value]) => actual.scope[key as keyof typeof actual.scope] === value,
    ) ||
    actual.scope.installationId !== parsedOwner.installationId ||
    actual.scope.profileId !== parsedOwner.profileId ||
    actual.scope.ownerUserId !== parsedOwner.ownerUserId ||
    actual.scope.teamId !== parsedOwner.teamId
  )
    throw new Error("ponder_desktop_project_authority_changed");
}

/** Called only by the explicit local human control; writes serialize with logout/unlink. */
export function setPonderProjectSharing(
  db: OpenPondSqliteConnection,
  input: PonderProjectSharingInput,
) {
  const sharing = PonderProjectSharingInputSchema.parse(input);
  assertAuthority(db, sharing.owner, sharing.authority);
  const key = ownerKey(sharing.owner);
  const existing = db.get<{ payload: string }>(
    "SELECT payload FROM ponder_project_sharing WHERE owner_key = ? AND project_id = ?",
    [key, sharing.project.projectId],
  );
  if (!existing) {
    const count = db.get<{ count: number }>(
      "SELECT count(*) AS count FROM ponder_project_sharing WHERE owner_key = ?",
      [key],
    );
    if ((count?.count ?? 0) >= PONDER_DESKTOP_CATALOG_MAX_TARGETS)
      throw new Error("ponder_desktop_project_sharing_limit_exceeded");
  }
  const previous = existing ? PonderProjectSharingSchema.parse(JSON.parse(existing.payload)) : null;
  const unchanged =
    previous &&
    previous.shared === sharing.shared &&
    previous.project.revision === sharing.project.revision &&
    previous.authority.authorizationRevision === sharing.authority.authorizationRevision &&
    Object.entries(sharing.authority.scope).every(
      ([key, value]) =>
        previous.authority.scope[key as keyof typeof previous.authority.scope] === value,
    );
  const record = PonderProjectSharingSchema.parse({
    ...sharing,
    revision: previous ? previous.revision + (unchanged ? 0 : 1) : 1,
  });
  db.run(
    "INSERT INTO ponder_project_sharing (owner_key, project_id, payload) VALUES (?, ?, ?) ON CONFLICT(owner_key, project_id) DO UPDATE SET payload = excluded.payload",
    [key, sharing.project.projectId, JSON.stringify(record)],
  );
  return record;
}

/** Revoked or superseded grants remain explicit restrictions; they never imply a fresh share. */
export function readPonderProjectSharing(db: OpenPondSqliteConnection, owner: PonderLocalOwner) {
  const rows = db.all<{ payload: string }>(
    "SELECT payload FROM ponder_project_sharing WHERE owner_key = ? ORDER BY project_id LIMIT ?",
    [ownerKey(owner), PONDER_DESKTOP_CATALOG_MAX_TARGETS + 1],
  );
  if (rows.length > PONDER_DESKTOP_CATALOG_MAX_TARGETS)
    throw new Error("ponder_desktop_project_sharing_limit_exceeded");
  return rows.map((row) => {
    const sharing = PonderProjectSharingSchema.parse(JSON.parse(row.payload));
    if (ownerKey(sharing.owner) !== ownerKey(owner))
      throw new Error("ponder_desktop_project_owner_changed");
    return sharing;
  });
}

export function projectSharingMatchesAuthority(
  sharing: PonderProjectSharing,
  authority: PonderProjectSharingAuthority,
) {
  return (
    sharing.shared &&
    sharing.authority.authorizationRevision === authority.authorizationRevision &&
    Object.entries(authority.scope).every(
      ([key, value]) => sharing.authority.scope[key as keyof typeof authority.scope] === value,
    )
  );
}
