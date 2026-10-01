import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { test, expect } from "vitest";
import { SqliteStore } from "../apps/server/src/store/store.js";
import { createLocalProfileOriginAdapter } from "../apps/server/src/evaluations/local-experiment-profile-origin.js";
import { resolveLocalProfileExperimentSource } from "../apps/server/src/evaluations/local-experiment-profile-source.js";
import { materializeProfileOrigin } from "../apps/server/src/evaluations/local-experiment-profile-origin-materialization.js";
import { contentHash } from "@openpond/harness";

// Failure story: cached remote bytes must never acquire device authority across
// restart, account changes or edited provenance, even if a release hash matches.
test("installed Profile origin remains exact and owner-authorized across SQLite restart", async () => {
  const home = await mkdtemp(
    path.join(os.tmpdir(), "profile-origin-boundary-"),
  );
  let store = new SqliteStore(home);
  const revision = "a".repeat(40),
    manifest = {
      schema: "openpond.profileRepo.v1",
      defaultProfile: "default",
      profiles: { default: { path: "profiles/default", enabledAgents: [] } },
    };
  const files = new Map([
    ["openpond-profile.json", JSON.stringify(manifest)],
    ["profiles/default/.keep", ""],
  ]);
  const entries = [...files].map(([path, contents]) => ({
    path,
    type: "file",
    sizeBytes: Buffer.byteLength(contents),
    mode: "100644",
    oid: createHash("sha1")
      .update(`blob ${Buffer.byteLength(contents)}\0`)
      .update(contents)
      .digest("hex"),
  }));
  let actorId = "actor",
    teamId = "team",
    allowed = true,
    sourceRevision = revision,
    downloads = 0;
  const project = {
    id: "project",
    teamId: "team",
    name: "Profile",
    metadata: {
      hostedProfileRepo: {
        sourceUpload: { sourceCommitSha: revision },
        manifest,
      },
    },
  };
  const fetcher: typeof fetch = async (input, options) => {
    const url = new URL(String(input));
    if (!allowed) return Response.json({ error: "denied" }, { status: 404 });
    const current = {
      ...project,
      metadata: {
        ...project.metadata,
        hostedProfileRepo: {
          ...project.metadata.hostedProfileRepo,
          sourceUpload: { sourceCommitSha: sourceRevision },
        },
      },
    };
    if (options?.method !== "POST")
      return Response.json(
        url.pathname.endsWith("/project")
          ? { project: current }
          : { projects: [current] },
      );
    downloads++;
    const query = JSON.parse(String(options.body)) as { path?: string };
    const name = query.path ?? entries[0]!.path,
      entry = entries.find((item) => item.path === name)!;
    return Response.json({
      commitSha: revision,
      entries,
      truncated: false,
      selectedFile: {
        path: name,
        sizeBytes: entry.sizeBytes,
        contents: files.get(name),
        encoding: "utf8",
        isBinary: false,
        truncated: false,
      },
    });
  };
  const adapter = () =>
    createLocalProfileOriginAdapter({
      store,
      storeDir: home,
      fetch: fetcher,
      resolveAccess: async () => ({
        apiBaseUrl: "https://origin.example",
        token: "test-owned",
        actorId,
        teamId,
      }),
    });
  try {
    const origin = adapter(),
      [catalog, concurrent] = await Promise.all([
        origin.discover(),
        origin.discover(),
      ]);
    expect(concurrent).toEqual(catalog);
    expect(downloads).toBe(3);
    expect(catalog).toHaveLength(1);
    const ref = catalog[0]!.ref;
    const selected = await origin.workflows(ref),
      workspace = (await store.listHarnessWorkspaces())[0]!;
    expect(workspace.ownerScope).toEqual({ kind: "team", id: "team" });
    expect(workspace.metadata.selectionEligible).toBe(false);
    expect(ref.source).toBe("openpond_git");
    expect(
      await resolveLocalProfileExperimentSource(
        store,
        selected.harnessRelease,
        ref,
        origin.authority,
      ),
    ).toBeTruthy();
    await expect(
      resolveLocalProfileExperimentSource(store, selected.harnessRelease, ref),
    ).rejects.toThrow();
    const bytesRead = downloads;
    await store.close();
    store = new SqliteStore(home);
    expect((await adapter().workflows(ref)).harnessRelease).toEqual(
      selected.harnessRelease,
    );
    expect(downloads).toBe(bytesRead);
    actorId = "other-actor";
    await expect(adapter().workflows(ref)).rejects.toThrow();
    expect(downloads).toBe(bytesRead);
    actorId = "actor";
    teamId = "other-team";
    await expect(adapter().workflows(ref)).rejects.toThrow();
    teamId = "team";
    allowed = false;
    await expect(adapter().workflows(ref)).rejects.toThrow();
    allowed = true;
    sourceRevision = "b".repeat(40);
    await expect(adapter().workflows(ref)).rejects.toThrow();
    sourceRevision = revision;
    await expect(
      adapter().authority(
        {
          ...workspace,
          metadata: {
            ...workspace.metadata,
            profileExperimentOrigin: {
              ...(workspace.metadata.profileExperimentOrigin as object),
              sourcePath: home,
            },
          },
        },
        selected.harnessRelease,
        ref,
      ),
    ).rejects.toThrow();
    const originPath = (
      workspace.metadata.profileExperimentOrigin as { sourcePath: string }
    ).sourcePath;
    await writeFile(
      path.join(originPath, "profiles/default/.keep"),
      "tampered unused file",
    );
    await expect(adapter().workflows(ref)).rejects.toThrow();
    const bad = {
      commitSha: revision,
      entries: [{ ...entries[0], path: "../escape" }],
      selectedFile: null,
      truncated: false,
    };
    await expect(
      materializeProfileOrigin({
        root: path.join(home, "bad"),
        revision,
        read: async () => bad,
      }),
    ).rejects.toThrow();
    expect(contentHash(selected.harnessRelease)).toMatch(/^[a-f0-9]{64}$/);
  } finally {
    await store.close();
    await rm(home, { recursive: true, force: true });
  }
});
