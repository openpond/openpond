import { rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { contentHash } from "@openpond/harness";
import { inspectOpenPondProfileSource } from "@openpond/cloud";
import type { HarnessWorkspace, OpenPondProfileRef } from "@openpond/contracts";
import type { HarnessStateStore } from "../store/harness-state-store.js";
import {
  importProfileIntoLocalHarnessWorkspace,
  compileProfileHarnessSource,
} from "../harness/local-harness-workspace-service.js";
import { profileWorkflowsForRelease } from "../harness/local-profile-workflow-runtime.js";
import { hostedApiAuthHeaders } from "../openpond/hosted-api-access.js";
import {
  materializeProfileOrigin,
  profileOriginFilesHash,
} from "./local-experiment-profile-origin-materialization.js";
import { LocalExperimentError } from "./local-experiment-contract.js";

const refSchema = z
  .object({
    source: z.literal("openpond_git"),
    repositoryId: z.string().min(1),
    profileId: z.string().min(1),
  })
  .strict();
const originSchema = z
  .object({
    schemaVersion: z.literal("openpond.profileExperimentOrigin.v1"),
    apiBaseUrl: z.string().url(),
    actorId: z.string().min(1),
    teamId: z.string().min(1),
    projectId: z.string().min(1),
    ref: refSchema,
    sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
    sourcePath: z.string(),
    sourceFilesHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const projectSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  name: z.string(),
  metadata: z.record(z.string(), z.unknown()),
});
export type ProfileOrigin = z.infer<typeof originSchema>;
export type ProfileOriginAuthority = (
  workspace: HarnessWorkspace,
  reference: { id: string; contentHash: string },
  ref: OpenPondProfileRef,
  options?:{requireCurrentRevision?:boolean},
) => Promise<void>;

/** Source origin is persisted by this trusted factory, never by run payloads.
 * Every operation resolves current server credentials and repeats owner ACL. */
export function createLocalProfileOriginAdapter(deps: {
  store: HarnessStateStore;
  storeDir: string;
  resolveAccess(): Promise<{
    apiBaseUrl: string;
    token: string;
    actorId: string;
    teamId: string;
  }>;
  fetch?: typeof fetch;
}) {
  const request = async (
    access: Awaited<ReturnType<typeof deps.resolveAccess>>,
    pathname: string,
    body?: unknown,
  ) => {
    const headers = hostedApiAuthHeaders(access.token);
    headers.set("x-openpond-team-id", access.teamId);
    if (body !== undefined) headers.set("content-type", "application/json");
    const response = await (deps.fetch ?? fetch)(
      new URL(pathname, access.apiBaseUrl),
      {
        method: body === undefined ? "GET" : "POST",
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    if (!response.ok)
      throw new LocalExperimentError(
        "local_profile_origin_access_denied",
        "This Profile origin is unavailable to the current account.",
        response.status === 401 ? 401 : 403,
      );
    const text = await response.text();
    if (Buffer.byteLength(text) > 40_000_000)
      throw new Error("Profile origin response exceeds its size limit.");
    return JSON.parse(text) as unknown;
  };
  function source(project: z.infer<typeof projectSchema>) {
    const hosted = z
      .object({
        sourceUpload: z.object({
          sourceCommitSha: z.string().regex(/^[a-f0-9]{40}$/),
        }),
        manifest: z.object({ profiles: z.record(z.string(), z.unknown()) }),
      })
      .parse(project.metadata.hostedProfileRepo);
    return {
      revision: hosted.sourceUpload.sourceCommitSha,
      profiles: Object.keys(hosted.manifest.profiles),
    };
  }
  async function authorize(
    origin: ProfileOrigin,
    workspace?: HarnessWorkspace,
    options:{requireCurrentRevision?:boolean}={},
  ) {
    const access = await deps.resolveAccess();
    if (
      access.actorId !== origin.actorId ||
      access.teamId !== origin.teamId ||
      access.apiBaseUrl.replace(/\/$/, "") !==
        origin.apiBaseUrl.replace(/\/$/, "") ||
      origin.projectId !== origin.ref.repositoryId ||
      (workspace &&
        (workspace.ownerScope.kind !== "team" ||
          workspace.ownerScope.id !== origin.teamId ||
          workspace.location !== "local" ||
          workspace.metadata.selectionEligible !== false))
    )
      throw new LocalExperimentError(
        "local_profile_origin_access_denied",
        "The cached Profile belongs to another actor or origin.",
        403,
      );
    const result = z
      .object({ project: projectSchema })
      .parse(
        await request(
          access,
          `/v1/projects/${encodeURIComponent(origin.projectId)}?teamId=${encodeURIComponent(access.teamId)}`,
        ),
      );
    const available = source(result.project);
    if (
      result.project.id !== origin.projectId ||
      result.project.teamId !== origin.teamId ||
      (options.requireCurrentRevision!==false&&available.revision !== origin.sourceRevision) ||
      !available.profiles.includes(origin.ref.profileId)
    )
      throw new LocalExperimentError(
        "local_profile_origin_changed",
        "The original committed Profile origin has changed or is no longer accessible.",
        409,
      );
    return access;
  }
  async function cached(
    ref: OpenPondProfileRef,
    reference?: { id: string; contentHash: string },
  ) {
    for (const workspace of await deps.store.listHarnessWorkspaces()) {
      const parsed = originSchema.safeParse(
        workspace.metadata.profileExperimentOrigin,
      );
      if (!parsed.success || contentHash(parsed.data.ref) !== contentHash(ref))
        continue;
      const release = reference
        ? await deps.store.getHarnessReleaseRecord(reference.contentHash)
        : workspace.currentChannel.release &&
          (await deps.store.getHarnessReleaseRecord(
            workspace.currentChannel.release.contentHash,
          ));
      if (
        !release ||
        release.workspaceId !== workspace.id ||
        (reference && release.harnessRelease.id !== reference.id)
      )
        continue;
      return { workspace, release, origin: parsed.data };
    }
    throw new LocalExperimentError(
      "local_profile_origin_access_denied",
      "The exact Profile has no trusted installed origin on this device.",
      403,
    );
  }
  const authority: ProfileOriginAuthority = async (
    workspace,
    reference,
    ref,
    options,
  ) => {
    const origin = originSchema.parse(
      workspace.metadata.profileExperimentOrigin,
    );
    if (contentHash(origin.ref) !== contentHash(ref))
      throw new Error("Profile origin reference was substituted.");
    await authorize(origin, workspace,options);
    const expectedId = `profile-origin-${contentHash([origin.apiBaseUrl, origin.actorId, origin.teamId, origin.ref, origin.sourceRevision]).slice(0, 40)}`;
    if (
      workspace.id !== expectedId ||
      origin.sourcePath !==
        path.join(
          deps.storeDir,
          "library",
          "profile-experiment-origins",
          expectedId,
        )
    )
      throw new Error("Profile origin provenance was substituted.");
    if (
      (await profileOriginFilesHash(origin.sourcePath)) !==
      origin.sourceFilesHash
    )
      throw new Error(
        "Installed Profile tree differs from its complete committed source.",
      );
    const profile = await inspectOpenPondProfileSource(
      origin.sourcePath,
      ref.profileId,
    );
    if (profile.error || !profile.sourcePath)
      throw new Error("The installed Profile source is incomplete.");
    const compiled = await compileProfileHarnessSource({
      storeDir: deps.storeDir,
      workspaceId: workspace.id,
      name: ref.profileId,
      profile,
      repositoryId: ref.repositoryId,
      sourceRevision: origin.sourceRevision,
    });
    if (
      compiled.harnessRelease.id !== reference.id ||
      compiled.harnessRelease.contentHash !== reference.contentHash
    )
      throw new Error(
        "Installed Profile source differs from its original compiler identity.",
      );
    await authorize(origin, workspace,options);
  };
  async function workflows(
    ref: OpenPondProfileRef,
    pin?: {
      sourceRevision: string;
      harnessRelease: { id: string; contentHash: string };
    },
  ) {
    const installed = await cached(ref, pin?.harnessRelease);
    await authority(
      installed.workspace,
      {
        id: installed.release.harnessRelease.id,
        contentHash: installed.release.harnessRelease.contentHash,
      },
      ref,
    );
    if (pin && pin.sourceRevision !== installed.origin.sourceRevision)
      throw new Error("Selected Profile source revision changed.");
    return profileWorkflowsForRelease({
      store: deps.store,
      ref,
      release: installed.release,
      sourceRevision: installed.origin.sourceRevision,
    });
  }
  const pending = new Map<string, Promise<HarnessWorkspace>>();
  async function install(
    project: z.infer<typeof projectSchema>,
    ref: z.infer<typeof refSchema>,
    revision: string,
    access: Awaited<ReturnType<typeof deps.resolveAccess>>,
  ) {
    const profileId = ref.profileId;
    const key = contentHash([
      access.apiBaseUrl,
      access.actorId,
      access.teamId,
      ref,
      revision,
    ]);
    const existing = pending.get(key);
    if (existing) return existing;
    const load = (async () => {
      const id = `profile-origin-${contentHash([access.apiBaseUrl, access.actorId, access.teamId, ref, revision]).slice(0, 40)}`;
      let workspace = await deps.store.getHarnessWorkspace(id);
      if (!workspace) {
        const sourcePath = path.join(
          deps.storeDir,
          "library",
          "profile-experiment-origins",
          id,
        );
        const initial = {
          schemaVersion: "openpond.profileExperimentOrigin.v1" as const,
          apiBaseUrl: access.apiBaseUrl,
          actorId: access.actorId,
          teamId: access.teamId,
          projectId: project.id,
          ref,
          sourceRevision: revision,
          sourcePath,
          sourceFilesHash: "0".repeat(64),
        };
        await authorize(initial);
        await rm(sourcePath, { recursive: true, force: true });
        const files = await materializeProfileOrigin({
          root: sourcePath,
          revision: revision,
          read: (query) =>
            request(
              access,
              `/v1/projects/${encodeURIComponent(project.id)}/files`,
              { teamId: access.teamId, ...query },
            ),
        });
        const origin = { ...initial, sourceFilesHash: contentHash(files) };
        await authorize(origin);
        const profile = await inspectOpenPondProfileSource(
          sourcePath,
          profileId,
        );
        if (profile.error || !profile.sourcePath)
          throw new Error("Profile source is invalid.");
        const installed = await importProfileIntoLocalHarnessWorkspace({
          store: deps.store,
          storeDir: deps.storeDir,
          id,
          ownerId: access.actorId,
          name: profileId,
          profile,
          sourceRevision: revision,
          repositoryId: project.id,
          selectionEligible: false,
          originOwnerScope: { kind: "team", id: access.teamId },
          originMetadata: { profileExperimentOrigin: origin },
        });
        workspace = installed.workspace;
      }
      return workspace!;
    })();
    pending.set(key, load);
    try {
      return await load;
    } finally {
      pending.delete(key);
    }
  }
  async function discover() {
    const access = await deps.resolveAccess();
    const { projects } = z
      .object({ projects: z.array(projectSchema).max(1000) })
      .parse(
        await request(
          access,
          `/v1/projects?teamId=${encodeURIComponent(access.teamId)}&role=profile`,
        ),
      );
    const entries: Array<{ ref: OpenPondProfileRef; name: string }> = [];
    let attempts = 0;
    for (const project of projects.slice(0, 100)) {
      try {
        if (project.teamId !== access.teamId) continue;
        const available = source(project);
        for (const profileId of available.profiles.slice(0, 20)) {
          if (++attempts > 100) return entries;
          const ref = {
            source: "openpond_git" as const,
            repositoryId: project.id,
            profileId,
          };
          await install(project, ref, available.revision, access);
          await workflows(ref);
          entries.push({
            ref,
            name: `${project.name} / ${profileId} (installed origin)`,
          });
        }
      } catch {
        /* Inaccessible, changed, or unsupported source is not advertised. */
      }
    }
    return entries;
  }
  return {
    authority,
    workflows,
    discover,
    resolveRef: async (
      repositoryId: string,
      profileId: string,
      reference: { id: string; contentHash: string },
    ) => {
      const ref = { source: "openpond_git" as const, repositoryId, profileId };
      const installed = await cached(ref, reference);
      await authority(installed.workspace, reference, ref);
      return ref;
    },
  };
}
