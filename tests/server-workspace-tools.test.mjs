import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { promisify } from "node:util";
import { createOpenPondServer } from "../apps/server/dist/index.js";

const execFileAsync = promisify(execFile);

async function api(server, token, route, init) {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`${server}${route}`, { ...init, headers });
  if (!response.ok) throw new Error(`${route} failed: ${response.status} ${await response.text()}`);
  return response.json();
}

async function withServer(fn) {
  const storeDir = await mkdtemp(path.join(os.tmpdir(), "openpond-server-tools-test-"));
  const instance = await createOpenPondServer({ port: 0, storeDir, silent: true });
  try {
    await fn(instance);
  } finally {
    await instance.close();
    await rm(storeDir, { recursive: true, force: true });
  }
}

async function git(cwd, args) {
  return execFileAsync("git", args, { cwd });
}

describe("server workspace tool harness", () => {
  test("adds a non-git local project and executes generic file tools", async () => {
    await withServer(async (instance) => {
      const projectDir = await mkdtemp(path.join(os.tmpdir(), "openpond-local-project-test-"));
      try {
        const realProjectDir = await realpath(projectDir);
        await writeFile(path.join(projectDir, "README.md"), "# Local project\n", "utf8");
        await writeFile(
          path.join(projectDir, "package.json"),
          `${JSON.stringify({ dependencies: { "openpond-agent-sdk": "^1.0.0" } })}\n`,
          "utf8"
        );
        const created = await api(instance.url, instance.token, "/v1/projects", {
          method: "POST",
          body: JSON.stringify({ path: projectDir }),
        });
        assert.equal(created.project.source, "folder");
        assert.equal(created.project.repoPath, null);
        assert.equal(Object.hasOwn(created.project, "agentSdk"), false);
        assert.ok(created.bootstrap.localProjects.some((project) => project.id === created.project.id));

        const state = await api(instance.url, instance.token, `/v1/workspaces/${created.project.id}?ensure=1`);
        assert.equal(state.initialized, true);
        assert.equal(state.source, "local_folder");
        assert.equal(state.currentBranch, null);

        const diff = await api(instance.url, instance.token, `/v1/workspaces/${created.project.id}/diff`);
        assert.equal(diff.initialized, true);
        assert.ok(diff.repoFiles.includes("README.md"));

        const file = await api(
          instance.url,
          instance.token,
          `/v1/workspaces/${created.project.id}/file?path=${encodeURIComponent("README.md")}`
        );
        assert.equal(file.content, "# Local project\n");

        const session = await api(instance.url, instance.token, "/v1/sessions", {
          method: "POST",
          body: JSON.stringify({
            provider: "openpond",
            title: "local project",
            workspaceKind: "local_project",
            workspaceId: created.project.id,
            workspaceName: created.project.name,
            cwd: created.project.workspacePath,
          }),
        });
        assert.equal(session.workspaceKind, "local_project");
        assert.equal(session.workspaceId, created.project.id);
        assert.equal(session.cwd, created.project.workspacePath);

        const list = await api(instance.url, instance.token, `/v1/sessions/${session.id}/workspace-tools`, {
          method: "POST",
          body: JSON.stringify({ action: "list_files" }),
        });
        assert.equal(list.ok, true, list.output);
        assert.ok(list.data.files.includes("README.md"));

        const write = await api(instance.url, instance.token, `/v1/sessions/${session.id}/workspace-tools`, {
          method: "POST",
          body: JSON.stringify({
            action: "write_file",
            args: {
              path: "notes.txt",
              content: "Saved from a local project chat.\n",
            },
          }),
        });
        assert.equal(write.ok, true, write.output);
        assert.equal(await readFile(path.join(projectDir, "notes.txt"), "utf8"), "Saved from a local project chat.\n");

        const init = await api(instance.url, instance.token, `/v1/sessions/${session.id}/workspace-tools`, {
          method: "POST",
          body: JSON.stringify({ action: "git_init" }),
        });
        assert.equal(init.ok, true, init.output);
        assert.equal(init.data.status.branch, "master");
        assert.equal(init.data.project.source, "git");
        assert.equal(init.data.project.repoPath, realProjectDir);
        assert.match((await git(projectDir, ["branch", "--show-current"])).stdout.trim(), /^master$/);

        const initializedState = await api(instance.url, instance.token, `/v1/workspaces/${created.project.id}?ensure=1`);
        assert.equal(initializedState.source, "local_git");
        assert.equal(initializedState.currentBranch, "master");
        assert.equal(initializedState.dirty, true);

        const afterInit = await api(instance.url, instance.token, "/v1/bootstrap");
        const initializedProject = afterInit.localProjects.find((project) => project.id === created.project.id);
        assert.equal(initializedProject.source, "git");
        assert.equal(initializedProject.repoPath, realProjectDir);

        const removed = await api(instance.url, instance.token, `/v1/projects/${created.project.id}`, {
          method: "DELETE",
        });
        assert.ok(!removed.localProjects.some((project) => project.id === created.project.id));
        const demotedSession = removed.sessions.find((candidate) => candidate.id === session.id);
        assert.equal(demotedSession.workspaceKind, undefined);
        assert.equal(demotedSession.workspaceId, null);
        assert.equal(demotedSession.workspaceName, null);
        assert.equal(await readFile(path.join(projectDir, "notes.txt"), "utf8"), "Saved from a local project chat.\n");
      } finally {
        await rm(projectDir, { recursive: true, force: true });
      }
    });
  });

  test("creates a new local project folder in a configured directory", async () => {
    await withServer(async (instance) => {
      const projectRoot = await mkdtemp(path.join(os.tmpdir(), "openpond-new-project-root-"));
      try {
        const realProjectRoot = await realpath(projectRoot);
        const created = await api(instance.url, instance.token, "/v1/projects", {
          method: "POST",
          body: JSON.stringify({
            createNew: true,
            name: "Scratch Project",
            baseDirectory: projectRoot,
          }),
        });

        assert.equal(created.project.name, "Scratch Project");
        assert.equal(created.project.source, "git");
        assert.equal(created.project.repoPath, created.project.path);
        assert.equal(path.dirname(created.project.path), realProjectRoot);
        assert.equal(path.basename(created.project.path), "Scratch Project");
        assert.equal((await stat(created.project.path)).isDirectory(), true);
        assert.match((await git(created.project.path, ["branch", "--show-current"])).stdout.trim(), /^master$/);
        assert.ok(created.bootstrap.localProjects.some((project) => project.id === created.project.id));

        const duplicate = await api(instance.url, instance.token, "/v1/projects", {
          method: "POST",
          body: JSON.stringify({
            createNew: true,
            name: "Scratch Project",
            baseDirectory: projectRoot,
          }),
        });

        assert.equal(path.basename(duplicate.project.path), "Scratch Project 2");
        assert.equal((await stat(duplicate.project.path)).isDirectory(), true);
      } finally {
        await rm(projectRoot, { recursive: true, force: true });
      }
    });
  });

  test("adds nested folders from the same Git repo as separate local projects", async () => {
    await withServer(async (instance) => {
      const repoDir = await mkdtemp(path.join(os.tmpdir(), "openpond-monorepo-project-test-"));
      try {
        const packageDir = path.join(repoDir, "packages", "agent");
        await mkdir(packageDir, { recursive: true });
        const realRepoDir = await realpath(repoDir);
        const realPackageDir = await realpath(packageDir);
        await writeFile(path.join(repoDir, "README.md"), "# Repo\n", "utf8");
        await writeFile(path.join(packageDir, "README.md"), "# Agent\n", "utf8");
        await git(repoDir, ["init"]);

        const root = await api(instance.url, instance.token, "/v1/projects", {
          method: "POST",
          body: JSON.stringify({ path: repoDir, name: "Root repo" }),
        });
        const nested = await api(instance.url, instance.token, "/v1/projects", {
          method: "POST",
          body: JSON.stringify({ path: packageDir, name: "Agent package" }),
        });

        assert.notEqual(nested.project.id, root.project.id);
        assert.equal(root.created, true);
        assert.equal(nested.created, true);
        assert.equal(root.project.workspacePath, realRepoDir);
        assert.equal(root.project.repoPath, realRepoDir);
        assert.equal(nested.project.workspacePath, realPackageDir);
        assert.equal(nested.project.repoPath, realRepoDir);
        assert.ok(nested.bootstrap.localProjects.some((project) => project.id === root.project.id));
        assert.ok(nested.bootstrap.localProjects.some((project) => project.id === nested.project.id));

        const reopened = await api(instance.url, instance.token, "/v1/projects", {
          method: "POST",
          body: JSON.stringify({ path: packageDir, name: "Agent package" }),
        });
        assert.equal(reopened.project.id, nested.project.id);
        assert.equal(reopened.created, false);
      } finally {
        await rm(repoDir, { recursive: true, force: true });
      }
    });
  });

  test("marks sandbox-template repos even when they also contain OpenTool packages", async () => {
    await withServer(async (instance) => {
      const projectDir = await mkdtemp(path.join(os.tmpdir(), "openpond-sandbox-template-project-"));
      try {
        const realProjectDir = await realpath(projectDir);
        await mkdir(path.join(projectDir, "tools"), { recursive: true });
        await writeFile(
          path.join(projectDir, "openpond.yaml"),
          [
            "schemaVersion: 1",
            "name: estimator",
            "version: 0.1.0",
            "useCase: estimating",
            "description: Estimate a project from local inputs.",
            "runtime:",
            "  base: node-bun-workspace",
            "validation:",
            "  commands:",
            "    - echo ok",
            "start:",
            "  command: echo ok",
            "actions: []",
            "services: []",
            "",
          ].join("\n"),
          "utf8"
        );
        await writeFile(
          path.join(projectDir, "package.json"),
          `${JSON.stringify(
            {
              private: true,
              devDependencies: { opentool: "0.21.0" },
            },
            null,
            2
          )}\n`,
          "utf8"
        );
        await writeFile(path.join(projectDir, "tools", "agent.ts"), "export async function GET() { return Response.json({ ok: true }); }\n", "utf8");
        await git(projectDir, ["init"]);

        const created = await api(instance.url, instance.token, "/v1/projects", {
          method: "POST",
          body: JSON.stringify({ path: projectDir, name: "Estimator Template" }),
        });

        assert.equal(created.project.source, "git");
        assert.equal(created.project.sandboxTemplate.detected, true);
        assert.equal(created.project.sandboxTemplate.valid, true);
        assert.equal(created.project.sandboxTemplate.normalizedManifest.name, "estimator");
        assert.equal(created.project.sandboxTemplate.rootPath, realProjectDir);
        assert.equal(created.project.sandboxTemplate.manifestPath, path.join(realProjectDir, "openpond.yaml"));
      } finally {
        await rm(projectDir, { recursive: true, force: true });
      }
    });
  });

  test("creates and validates a sandbox-template scaffold in a local project", async () => {
    await withServer(async (instance) => {
      const projectDir = await mkdtemp(path.join(os.tmpdir(), "openpond-sandbox-template-scaffold-"));
      try {
        await git(projectDir, ["init"]);
        const created = await api(instance.url, instance.token, "/v1/projects", {
          method: "POST",
          body: JSON.stringify({ path: projectDir, name: "Sandbox Template Scaffold" }),
        });
        const session = await api(instance.url, instance.token, "/v1/sessions", {
          method: "POST",
          body: JSON.stringify({
            provider: "openpond",
            title: "sandbox scaffold",
            workspaceKind: "local_project",
            workspaceId: created.project.id,
            workspaceName: created.project.name,
            cwd: created.project.workspacePath,
          }),
        });

        const scaffold = await api(instance.url, instance.token, `/v1/sessions/${session.id}/workspace-tools`, {
          method: "POST",
          body: JSON.stringify({ action: "create_sandbox_template_scaffold" }),
        });
        assert.equal(scaffold.ok, true, scaffold.output);
        assert.ok(scaffold.data.files.includes("openpond.yaml"));
        assert.match(await readFile(path.join(projectDir, "openpond.yaml"), "utf8"), /schemaVersion: 1/);

        const validate = await api(instance.url, instance.token, `/v1/sessions/${session.id}/workspace-tools`, {
          method: "POST",
          body: JSON.stringify({ action: "validate_sandbox_template" }),
        });
        assert.equal(validate.ok, true, validate.output);
        assert.equal(validate.data.manifest.name, "sandbox-template-scaffold");

        const bootstrap = await api(instance.url, instance.token, "/v1/bootstrap");
        const project = bootstrap.localProjects.find((candidate) => candidate.id === created.project.id);
        assert.equal(project.sandboxTemplate.detected, true);
        assert.equal(project.sandboxTemplate.valid, true);
      } finally {
        await rm(projectDir, { recursive: true, force: true });
      }
    });
  });

});
