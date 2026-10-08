import {
  PONDER_DESKTOP_CATALOG_MAX_TARGETS,
  PonderDesktopProjectSharingRequestSchema,
  PonderDesktopProjectPageSchema,
  type AppPreferences,
  type LocalProject,
} from "@openpond/contracts";
import type { SqliteStore } from "../store/store.js";
import {
  projectSharingMatchesAuthority,
  type PonderProjectSharingAuthority,
} from "../store/ponder-project-sharing.js";
import {
  capturePonderProjectSnapshot,
  type PonderProjectSnapshot,
} from "./ponder-project-snapshot.js";
import { ponderSharedProjectWorkspaces } from "./ponder-desktop-workspaces.js";
import type { PonderLocalOwner } from "./ponder-local-scope.js";

type Connection = {
  owner: PonderLocalOwner;
  authority: PonderProjectSharingAuthority;
  credentialKey: string;
};
const sameAuthority = (left: Connection, right: Connection | null) =>
  right !== null &&
  left.credentialKey === right.credentialKey &&
  left.authority.authorizationRevision === right.authority.authorizationRevision &&
  Object.entries(left.authority.scope).every(
    ([key, value]) => right.authority.scope[key as keyof typeof right.authority.scope] === value,
  );

/** This service is reached only through local human controls, never through desktop operation tools. */
export function createPonderDesktopProjectService(deps: {
  store: Pick<SqliteStore, "readPonderProjectSharing" | "setPonderProjectSharing">;
  loadProjects(): Promise<LocalProject[]>;
  preferences(): Promise<AppPreferences>;
  current(): Promise<Connection | null>;
}) {
  async function projects() {
    const values = await deps.loadProjects();
    if (values.length > PONDER_DESKTOP_CATALOG_MAX_TARGETS)
      throw new Error("ponder_desktop_project_sharing_limit_exceeded");
    return values;
  }
  return {
    async workspaces(owner: PonderLocalOwner, authority: PonderProjectSharingAuthority) {
      const grants = await deps.store.readPonderProjectSharing(owner);
      const snapshots = new Map<string, PonderProjectSnapshot>();
      const grantedIds = new Set(
        grants
          .filter((grant) => projectSharingMatchesAuthority(grant, authority))
          .map((grant) => grant.project.projectId),
      );
      const all = grantedIds.size ? await projects() : [];
      for (const project of all) {
        if (!grantedIds.has(project.id)) continue;
        const snapshot = await capturePonderProjectSnapshot(project).catch(() => null);
        if (snapshot) snapshots.set(project.id, snapshot);
      }
      return ponderSharedProjectWorkspaces({
        grants,
        authority,
        snapshots,
        commandAccessMode: (await deps.preferences()).openPondCommandAccessMode,
      });
    },
    async list(after: string | null = null) {
      if (after && after.length > 200) throw new Error("ponder_desktop_project_cursor_invalid");
      const connection = await deps.current();
      if (!connection) return { authority: null, projects: [], nextCursor: null };
      const grants = await deps.store.readPonderProjectSharing(connection.owner);
      const all = await projects();
      const projectMap = new Map(all.map((project) => [project.id, project]));
      const grantMap = new Map(grants.map((grant) => [grant.project.projectId, grant]));
      const ids = [...new Set([...projectMap.keys(), ...grantMap.keys()])]
        .filter((id) => projectMap.has(id) || grantMap.get(id)?.shared)
        .sort();
      if (ids.length > PONDER_DESKTOP_CATALOG_MAX_TARGETS)
        throw new Error("ponder_desktop_project_sharing_limit_exceeded");
      const page = ids.filter((id) => !after || id > after).slice(0, 101);
      const values = [];
      for (const id of page.slice(0, 100)) {
        const project = projectMap.get(id),
          grant = grantMap.get(id);
        const snapshot = project
          ? await capturePonderProjectSnapshot(project).catch(() => null)
          : null;
        values.push({
          id,
          name: project?.name ?? grant!.project.name,
          cwd: snapshot?.cwd ?? grant?.project.cwd ?? null,
          revision: snapshot?.revision ?? null,
          available: snapshot !== null,
          previouslyShared: grant?.shared ?? false,
          shared:
            !!grant &&
            projectSharingMatchesAuthority(grant, connection.authority) &&
            snapshot?.revision === grant.project.revision,
        });
      }
      if (!sameAuthority(connection, await deps.current()))
        throw new Error("ponder_desktop_project_authority_changed");
      return PonderDesktopProjectPageSchema.parse({
        authority: connection.authority,
        projects: values,
        nextCursor: page.length > 100 ? page[99]! : null,
      });
    },
    async change(payload: unknown) {
      const input = PonderDesktopProjectSharingRequestSchema.parse(payload);
      const connection = await deps.current();
      if (
        !connection ||
        input.expectedAuthority.authorizationRevision !==
          connection.authority.authorizationRevision ||
        !Object.entries(input.expectedAuthority.scope).every(
          ([key, value]) =>
            connection.authority.scope[key as keyof typeof connection.authority.scope] === value,
        )
      )
        throw new Error("ponder_desktop_project_authority_changed");
      const existing = (await deps.store.readPonderProjectSharing(connection.owner)).find(
        (grant) => grant.project.projectId === input.projectId,
      );
      const project = (await projects()).find((project) => project.id === input.projectId);
      const snapshot = input.shared
        ? project && (await capturePonderProjectSnapshot(project))
        : existing?.project;
      if (!snapshot) throw new Error("ponder_desktop_project_unavailable");
      if (input.shared && snapshot.revision !== input.expectedRevision)
        throw new Error("ponder_desktop_project_changed");
      if (!sameAuthority(connection, await deps.current()))
        throw new Error("ponder_desktop_project_authority_changed");
      await deps.store.setPonderProjectSharing({
        owner: connection.owner,
        authority: connection.authority,
        project: snapshot,
        shared: input.shared,
        updatedAt: new Date().toISOString(),
      });
      if (!sameAuthority(connection, await deps.current()))
        throw new Error("ponder_desktop_project_authority_changed");
      return { projectId: input.projectId, shared: input.shared };
    },
  };
}
