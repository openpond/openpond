import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, expect, test } from "vitest";
import { initializeHome } from "@openpond/persistence";
import { installOpenPondProfile, updateInstalledOpenPondProfile } from "../apps/server/src/profile-installation.js";
import { ensureLocalProfileWorkflows, loadLocalProfileWorkflowRuntime } from "../apps/server/src/harness/local-profile-workflow-runtime.js";
import { SqliteStore } from "../apps/server/src/store/store.js";

const run = promisify(execFile);
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

test("GitHub-style Profile import and fast-forward update retain exact workflow releases", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openpond-profile-git-"));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const originalHome = process.env.OPENPOND_HOME;
  const home = path.join(root, "home");
  process.env.OPENPOND_HOME = home;
  cleanup.push(async () => {
    if (originalHome === undefined) delete process.env.OPENPOND_HOME;
    else process.env.OPENPOND_HOME = originalHome;
  });
  await initializeHome(home);
  const publicRoot = path.join(root, "public");
  const bare = path.join(publicRoot, "team", "repo.git");
  const author = path.join(root, "author");
  await fs.mkdir(path.dirname(bare), { recursive: true });
  await run("git", ["init", "--bare", bare]);
  await run("git", ["clone", bare, author]);
  await run("git", ["-C", author, "config", "user.name", "Profile Test"]);
  await run("git", ["-C", author, "config", "user.email", "profile-test@example.invalid"]);
  const sourcePath = path.join(author, "profiles", "team");
  await fs.mkdir(path.join(sourcePath, "workflows"), { recursive: true });
  await fs.mkdir(path.join(sourcePath, "settings"), { recursive: true });
  await fs.writeFile(path.join(author, "openpond-profile.json"), JSON.stringify({
    schema: "openpond.profileRepo.v1", defaultProfile: "team",
    profiles: { team: { path: "profiles/team", defaultAgent: "", enabledAgents: [] } },
  }));
  await fs.writeFile(path.join(sourcePath, "settings", "profile.yaml"), "schema: openpond.profile.v1\nprofile: team\nagents: []\n");
  const catalogPath = path.join(sourcePath, "workflows", "catalog.json");
  const catalog = { schemaVersion: "openpond.profileWorkflows.v1", workflows: [{
    id: "report", label: "Report", description: "Write a report.",
    inputSchema: { type: "object", properties: { subject: { type: "string" } }, required: ["subject"] },
    invocation: { kind: "instructions", instructions: "Write the first report." }, skillPaths: [],
  }] };
  await fs.writeFile(catalogPath, JSON.stringify(catalog));
  const publish = async () => {
    await run("git", ["-C", author, "add", "-A"]);
    await run("git", ["-C", author, "commit", "-m", "Update Profile workflow"]);
    await run("git", ["-C", author, "push", "origin", "HEAD"]);
    await run("git", ["-C", bare, "update-server-info"]);
  };
  await publish();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const child = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: publicRoot,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: request.method ?? "GET",
        CONTENT_TYPE: request.headers["content-type"] ?? "",
        CONTENT_LENGTH: request.headers["content-length"] ?? "0",
      },
    });
    request.pipe(child.stdin);
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("close", () => {
      const output = Buffer.concat(chunks);
      const separator = output.indexOf("\r\n\r\n");
      const alternative = separator < 0 ? output.indexOf("\n\n") : separator;
      if (alternative < 0) { response.writeHead(500).end(); return; }
      const headers = output.subarray(0, alternative).toString("utf8").split(/\r?\n/);
      let status = 200;
      for (const header of headers) {
        const index = header.indexOf(":");
        if (index < 0) continue;
        const name = header.slice(0, index).trim();
        const value = header.slice(index + 1).trim();
        if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
        else response.setHeader(name, value);
      }
      response.writeHead(status).end(output.subarray(alternative + (separator < 0 ? 2 : 4)));
    });
    child.once("error", () => response.writeHead(500).end());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test Git server did not bind a port.");
  const url = `http://127.0.0.1:${address.port}/team/repo.git`;
  const ref = { source: "github" as const, repositoryId: "team/repo", profileId: "team" };
  const first = await installOpenPondProfile({ source: "github", repositoryId: "team/repo", url, profile: "team" });
  expect(first.git?.head).toMatch(/^[a-f0-9]{40}$/);
  const store = new SqliteStore(home);
  cleanup.push(() => store.close());
  const firstDiscovery = await ensureLocalProfileWorkflows({ store, storeDir: home, ref, profile: first });
  expect(firstDiscovery.workflows[0]?.workflow.invocation).toEqual({ kind: "instructions", instructions: "Write the first report." });
  catalog.workflows[0]!.invocation.instructions = "Write the revised report.";
  await fs.writeFile(catalogPath, JSON.stringify(catalog));
  await publish();
  const updated = await updateInstalledOpenPondProfile(ref);
  expect(updated.git?.head).not.toBe(first.git?.head);
  const secondDiscovery = await ensureLocalProfileWorkflows({ store, storeDir: home, ref, profile: updated });
  expect(secondDiscovery.workflows[0]?.binding.harnessRelease.contentHash)
    .not.toBe(firstDiscovery.workflows[0]?.binding.harnessRelease.contentHash);
  expect((await loadLocalProfileWorkflowRuntime({
    store, binding: firstDiscovery.workflows[0]!.binding,
  })).workflow.invocation).toEqual({ kind: "instructions", instructions: "Write the first report." });
});
