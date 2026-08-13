import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { OpenPondProjectActionsClient } from "../src/project-actions";

afterEach(() => vi.restoreAllMocks());

describe("OpenPondProjectActionsClient", () => {
  test("publishes a built action release with the bundle and runner", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openpond-sdk-actions-"));
    const bundlePath = path.join(root, "bundle.mjs");
    const runnerPath = path.join(root, "runner.mjs");
    await Promise.all([
      fs.writeFile(bundlePath, "export const action = true;"),
      fs.writeFile(runnerPath, "process.exit(0);"),
    ]);
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      release: { id: "release_1", sourceCommitSha: "abc1234" },
    }, { status: 201 }));
    const client = new OpenPondProjectActionsClient({
      apiKey: "opk_test",
      apiBaseUrl: "https://api.example.test/",
    });

    const release = await client.publish({
      projectId: "project_1",
      teamId: "team_1",
      sourceRef: "main",
      sourceCommitSha: "abc1234",
      build: {
        projectRoot: root,
        outputDirectory: root,
        bundlePath,
        runnerPath,
        registryPath: path.join(root, "registry.json"),
        manifestPath: path.join(root, "manifest.json"),
        registry: { schemaVersion: "openpond.projectActionRegistry.v1", actions: [] },
        manifest: {
          schemaVersion: "openpond.projectActionBuild.v1",
          sourceDirectory: "openpond/actions",
          sourceFiles: [],
          bundleFile: "bundle.mjs",
          runnerFile: "runner.mjs",
          registryFile: "registry.json",
          bundleHash: "bundle_hash",
          registryHash: "registry_hash",
        },
      },
    });

    expect(release.id).toBe("release_1");
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://api.example.test/v1/project-actions/project_1/releases?teamId=team_1");
    const payload = JSON.parse(String(init?.body));
    expect(Buffer.from(payload.bundleBase64, "base64").toString()).toBe("export const action = true;");
    expect(payload.sourceCommitSha).toBe("abc1234");
  });

  test("pins a requested release when invoking an action", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      invocation: { id: "invocation_1", releaseId: "release_1", status: "succeeded" },
    }));
    const client = new OpenPondProjectActionsClient({
      apiKey: "opk_test",
      apiBaseUrl: "https://api.example.test",
    });

    await client.run({
      projectId: "project_1",
      teamId: "team_1",
      releaseId: "release_1",
      actionId: "analytics.get_summary",
      value: { businessId: "relocation" },
      idempotencyKey: "turn_1:call_1",
      callerType: "work",
    });

    const payload = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(payload).toMatchObject({
      releaseId: "release_1",
      idempotencyKey: "turn_1:call_1",
      callerType: "work",
    });
  });
});
