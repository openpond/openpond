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
        assert.equal(created.project.agentSdk.detected, true);
        assert.equal(created.project.agentSdk.version, "^1.0.0");
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

  test.skip("detects a nested OpenTool package inside a local Git project", async () => {
    await withServer(async (instance) => {
      const projectDir = await mkdtemp(path.join(os.tmpdir(), "openpond-nested-opentool-project-"));
      try {
        const appDir = path.join(projectDir, "apps", "agent");
        await mkdir(path.join(appDir, "tools"), { recursive: true });
        await writeFile(path.join(projectDir, "package.json"), `${JSON.stringify({ private: true })}\n`, "utf8");
        await writeFile(
          path.join(appDir, "package.json"),
          `${JSON.stringify(
            {
              scripts: { validate: "opentool validate" },
              devDependencies: { opentool: "0.21.0" },
            },
            null,
            2
          )}\n`,
          "utf8"
        );
        await writeFile(path.join(appDir, "tools", "agent.ts"), "export async function GET() { return Response.json({ ok: true }); }\n", "utf8");
        await git(projectDir, ["init"]);

        const created = await api(instance.url, instance.token, "/v1/projects", {
          method: "POST",
          body: JSON.stringify({ path: projectDir, name: "Nested OpenTool" }),
        });

        assert.equal(created.project.source, "git");
      } finally {
        await rm(projectDir, { recursive: true, force: true });
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

  test.skip("detects a local OpenTool project and publishes it to an OpenPond repo", async () => {
    const storeDir = await mkdtemp(path.join(os.tmpdir(), "openpond-local-opentool-publish-test-"));
    const projectDir = await mkdtemp(path.join(os.tmpdir(), "openpond-external-opentool-"));
    const previousHome = process.env.HOME;
    const originalFetch = globalThis.fetch;
    process.env.HOME = storeDir;
    const bareRemote = path.join(storeDir, "published-remote.git");
    await git(storeDir, ["init", "--bare", bareRemote]);
    await git(storeDir, [
      "config",
      "--global",
      `url.file://${bareRemote}.insteadOf`,
      "https://openpond.ai/openpondai/imported-opentool.git",
    ]);
    const instance = await createOpenPondServer({ port: 0, storeDir, silent: true });
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.origin === "https://api.test" && url.pathname === "/health") {
        return Response.json({ ok: true, authenticated: true });
      }
      if (url.origin === "https://api.test" && url.pathname === "/account") {
        return Response.json({ account: { id: "acct_1", handle: "publish-test" } });
      }
      if (url.origin === "https://api.test" && url.pathname === "/apps/list") {
        return Response.json({ apps: [] });
      }
      if (url.origin === "https://api.test" && url.pathname === "/apps/repo/create") {
        const body = JSON.parse(String(init?.body ?? "{}"));
        assert.equal(body.repoInit, "empty");
        return Response.json({
          appId: "app_imported_opentool",
          gitOwner: "openpondai",
          gitRepo: "imported-opentool",
          gitHost: "openpond.ai",
          repoUrl: "https://openpond.ai/openpondai/imported-opentool.git",
          defaultBranch: "main",
        });
      }
      return originalFetch(input, init);
    };

    try {
      await mkdir(path.join(projectDir, "tools"), { recursive: true });
      await writeFile(
        path.join(projectDir, "package.json"),
        `${JSON.stringify(
          {
            scripts: {
              validate: "node -e \"console.log('validate ok')\"",
              build: "node -e \"console.log('build ok')\"",
            },
            devDependencies: { opentool: "0.21.0" },
          },
          null,
          2
        )}\n`,
        "utf8"
      );
      await writeFile(path.join(projectDir, "tools", "echo.ts"), "export async function GET() { return Response.json({ ok: true }); }\n", "utf8");
      await writeFile(path.join(projectDir, ".gitignore"), "node_modules/\n", "utf8");
      await mkdir(path.join(projectDir, "node_modules", ".bin"), { recursive: true });
      await writeFile(path.join(projectDir, "node_modules", ".bin", "opentool"), "", "utf8");

      await api(instance.url, instance.token, "/v1/openpond/accounts/login", {
        method: "POST",
        body: JSON.stringify({
          handle: "publish-test",
          apiKey: "test-token",
          baseUrl: "https://openpond.ai",
          apiBaseUrl: "https://api.test",
          setActive: true,
        }),
      });
      const created = await api(instance.url, instance.token, "/v1/projects", {
        method: "POST",
        body: JSON.stringify({ path: projectDir, name: "Imported OpenTool" }),
      });
      assert.equal(created.project.opentool.detected, true);
      assert.equal(created.project.opentool.version, "0.21.0");
      assert.deepEqual(created.project.opentool.toolFiles, ["tools/echo.ts"]);
      assert.equal(created.project.linkedOpenPondApp, null);

      const session = await api(instance.url, instance.token, "/v1/sessions", {
        method: "POST",
        body: JSON.stringify({
          provider: "openpond",
          title: "publish project",
          workspaceKind: "local_project",
          workspaceId: created.project.id,
          workspaceName: created.project.name,
          cwd: created.project.workspacePath,
        }),
      });
      const publish = await api(instance.url, instance.token, `/v1/sessions/${session.id}/workspace-tools`, {
        method: "POST",
        body: JSON.stringify({ action: "publish_openpond_repo" }),
      });
      assert.equal(publish.ok, true, publish.output);
      assert.equal(publish.appId, "app_imported_opentool");
      assert.equal(publish.data.project.linkedOpenPondApp.appId, "app_imported_opentool");
      assert.ok(publish.data.initialCommit.commitSha);

      const origin = await git(projectDir, ["config", "--get", "remote.origin.url"]);
      assert.equal(origin.stdout.trim(), "https://openpond.ai/openpondai/imported-opentool.git");
      const remoteHead = await git(bareRemote, ["rev-parse", "refs/heads/main"]);
      assert.match(remoteHead.stdout.trim(), /^[a-f0-9]{40}$/);

      const bootstrap = await api(instance.url, instance.token, "/v1/bootstrap");
      const linked = bootstrap.localProjects.find((project) => project.id === created.project.id);
      assert.equal(linked.linkedOpenPondApp.appId, "app_imported_opentool");
      assert.ok(bootstrap.apps.some((app) => app.id === "app_imported_opentool"));
      const updatedSession = bootstrap.sessions.find((candidate) => candidate.id === session.id);
      assert.equal(updatedSession.appId, "app_imported_opentool");
      assert.equal(updatedSession.workspaceKind, "local_project");

      const validate = await api(instance.url, instance.token, `/v1/sessions/${session.id}/workspace-tools`, {
        method: "POST",
        body: JSON.stringify({ action: "validate_opentool" }),
      });
      assert.equal(validate.ok, true, validate.output);
    } finally {
      globalThis.fetch = originalFetch;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await instance.close();
      await rm(projectDir, { recursive: true, force: true });
      await rm(storeDir, { recursive: true, force: true });
    }
  });

  test.skip("creates a scaffold and executes file tools through HTTP", async () => {
    await withServer(async (instance) => {
      const templates = await api(instance.url, instance.token, "/v1/scaffold/templates");
      assert.deepEqual(
        templates.templates.map((template) => template.id),
        ["opentool-base", "opentool-mpp-proxy", "mpp-service-tool"]
      );
      assert.ok(templates.templates[0].expectedFiles.includes("openpond.config.json"));

      const session = await api(instance.url, instance.token, "/v1/sessions", {
        method: "POST",
        body: JSON.stringify({ provider: "openpond", title: "tool harness" }),
      });

      const scaffold = await api(instance.url, instance.token, `/v1/sessions/${session.id}/workspace-tools`, {
        method: "POST",
        body: JSON.stringify({
          action: "create_scaffold",
          args: {
            name: "Harness Agent",
            description: "Test scaffold through the server harness",
            mode: "local",
          },
        }),
      });
      assert.equal(scaffold.ok, true, scaffold.output);
      assert.ok(scaffold.appId);
      assert.equal(scaffold.data.mode, "local");
      assert.equal(scaffold.data.templateId, "opentool-base");

      const bootstrap = await api(instance.url, instance.token, "/v1/bootstrap");
      const updatedSession = bootstrap.sessions.find((candidate) => candidate.id === session.id);
      assert.equal(updatedSession.appId, scaffold.appId);
      assert.equal(updatedSession.cwd, scaffold.data.workspace.repoPath);
      assert.ok(bootstrap.apps.some((app) => app.id === scaffold.appId));

      const list = await api(instance.url, instance.token, `/v1/sessions/${session.id}/workspace-tools`, {
        method: "POST",
        body: JSON.stringify({ action: "list_files" }),
      });
      assert.equal(list.ok, true);
      assert.ok(list.data.files.includes("package.json"));
      assert.ok(list.data.files.includes("openpond.config.json"));

      const listedTemplates = await api(instance.url, instance.token, `/v1/sessions/${session.id}/workspace-tools`, {
        method: "POST",
        body: JSON.stringify({ action: "list_templates" }),
      });
      assert.equal(listedTemplates.ok, true);
      assert.deepEqual(
        listedTemplates.data.templates.map((template) => template.id),
        ["opentool-base", "opentool-mpp-proxy", "mpp-service-tool"]
      );

      const preview = await api(instance.url, instance.token, `/v1/sessions/${session.id}/workspace-tools`, {
        method: "POST",
        body: JSON.stringify({
          action: "preview_write_file",
          args: {
            path: "tools/echo.ts",
            content: "export const preview = true;\n",
          },
        }),
      });
      assert.equal(preview.ok, true, preview.output);
      assert.equal(preview.data.preview.filesChanged, 1);
      await assert.rejects(
        readFile(path.join(scaffold.data.workspace.repoPath, "tools", "echo.ts"), "utf8"),
        /no such file|ENOENT/i
      );

      const configUpdate = await api(instance.url, instance.token, `/v1/sessions/${session.id}/workspace-tools`, {
        method: "POST",
        body: JSON.stringify({
          action: "update_template_config",
          args: {
            config: {
              title: "Updated Harness Agent",
              search: { queries: ["robotics news"] },
              schedule: { cron: "0 8 * * 1-5" },
            },
            runChecks: false,
          },
        }),
      });
      assert.equal(configUpdate.ok, true, configUpdate.output);
      assert.deepEqual(configUpdate.data.changedKeys, ["schedule", "search", "title"]);
      assert.equal(configUpdate.data.envVar, "OPENTOOL_PUBLIC_AGENT_CONFIG");
      const configJson = JSON.parse(await readFile(path.join(scaffold.data.workspace.repoPath, "openpond.config.json"), "utf8"));
      assert.equal(configJson.defaults.title, "Updated Harness Agent");
      assert.deepEqual(configJson.defaults.search.queries, ["robotics news"]);

      const configView = await api(
        instance.url,
        instance.token,
        `/v1/openpond/apps/${encodeURIComponent(scaffold.appId)}/template-config`
      );
      assert.equal(configView.exists, true);
      assert.equal(configView.envVar, "OPENTOOL_PUBLIC_AGENT_CONFIG");
      assert.equal(configView.source, "local_file");
      assert.equal(configView.currentConfig.title, "Updated Harness Agent");
      assert.deepEqual(configView.currentConfig.search.queries, ["robotics news"]);

      const invalidConfigUpdate = await api(instance.url, instance.token, `/v1/sessions/${session.id}/workspace-tools`, {
        method: "POST",
        body: JSON.stringify({
          action: "update_template_config",
          args: {
            config: { imaginaryBehavior: true },
            runChecks: false,
          },
        }),
      });
      assert.equal(invalidConfigUpdate.ok, false);
      assert.match(invalidConfigUpdate.output, /Unknown template config keys/);

      const write = await api(instance.url, instance.token, `/v1/sessions/${session.id}/workspace-tools`, {
        method: "POST",
        body: JSON.stringify({
          action: "write_file",
          args: {
            path: "tools/echo.ts",
            content:
              'import { z } from "zod";\n\n' +
              "export const schema = z.object({ message: z.string() });\n\n" +
              "export async function POST(request: Request) {\n" +
              "  const input = schema.parse(await request.json());\n" +
              "  return Response.json({ message: input.message });\n" +
              "}\n",
            runChecks: false,
          },
        }),
      });
      assert.equal(write.ok, true, write.output);
      assert.equal(write.data.preview.filesChanged, 1);
      assert.match(write.data.preview.files[0].patch, /message/);

      const written = await readFile(path.join(scaffold.data.workspace.repoPath, "tools", "echo.ts"), "utf8");
      assert.match(written, /Response\.json/);

      const batchWrite = await api(instance.url, instance.token, `/v1/sessions/${session.id}/workspace-tools`, {
        method: "POST",
        body: JSON.stringify({
          action: "write_files",
          args: {
            files: {
              "tools/alpha.ts": "export async function GET() { return Response.json({ alpha: true }); }\n",
              "tools/beta.ts": "export async function GET() { return Response.json({ beta: true }); }\n",
            },
            runChecks: false,
          },
        }),
      });
      assert.equal(batchWrite.ok, true, batchWrite.output);

      const alpha = await readFile(path.join(scaffold.data.workspace.repoPath, "tools", "alpha.ts"), "utf8");
      assert.match(alpha, /alpha/);

      const gitStatus = await api(instance.url, instance.token, `/v1/sessions/${session.id}/workspace-tools`, {
        method: "POST",
        body: JSON.stringify({ action: "git_status" }),
      });
      assert.equal(gitStatus.ok, true, gitStatus.output);
      assert.equal(gitStatus.data.dirty, true);

      const gitCommit = await api(instance.url, instance.token, `/v1/sessions/${session.id}/workspace-tools`, {
        method: "POST",
        body: JSON.stringify({
          action: "git_commit",
          args: {
            message: "Add test tools",
            runChecks: false,
          },
        }),
      });
      assert.equal(gitCommit.ok, true, gitCommit.output);
      assert.ok(gitCommit.data.commitSha);

      const deployAttempt = await api(instance.url, instance.token, `/v1/sessions/${session.id}/workspace-tools`, {
        method: "POST",
        body: JSON.stringify({
          action: "deploy_preview",
          args: { runChecks: false },
        }),
      });
      assert.equal(deployAttempt.ok, false);
      assert.match(deployAttempt.output, /upstream|push|remote/i);

      const after = await api(instance.url, instance.token, "/v1/bootstrap");
      assert.ok(
        after.events.some(
          (event) =>
            event.name === "workspace_action_result" &&
            event.action === "create_scaffold" &&
            event.status === "completed"
        )
      );
      assert.ok(
        after.events.some(
          (event) =>
            event.name === "workspace_action_result" &&
            event.action === "write_file" &&
            event.status === "completed"
        )
      );
      assert.ok(
        after.events.some(
          (event) =>
            event.name === "workspace_action_result" &&
            event.action === "write_files" &&
            event.status === "completed"
        )
      );
      assert.ok(
        after.events.some(
          (event) =>
            event.name === "workspace_action_result" &&
            event.action === "git_commit" &&
            event.status === "completed"
        )
      );
    });
  });

  test.skip("executes hosted OpenTool recipe and rules tools through the workspace tool protocol", async () => {
    const storeDir = await mkdtemp(path.join(os.tmpdir(), "openpond-recipe-tools-test-"));
    const previousHome = process.env.HOME;
    const originalFetch = globalThis.fetch;
    process.env.HOME = storeDir;
    const instance = await createOpenPondServer({ port: 0, storeDir, silent: true });
    const calls = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.origin !== "https://api.test") return originalFetch(input, init);
      calls.push({ method: init?.method || "GET", pathname: url.pathname });
      if (url.pathname === "/health") {
        return Response.json({ ok: true, authenticated: true });
      }
      if (url.pathname === "/account") {
        return Response.json({ account: { id: "acct_1", handle: "recipe-test" }, products: [] });
      }
      if (url.pathname === "/apps/list") {
        return Response.json({ apps: [] });
      }
      if (url.pathname === "/v1/opentool/recipes" && (init?.method || "GET") === "GET") {
        return Response.json({
          recipes: [
            {
              id: "core/basic-get-tool",
              title: "Basic GET",
              summary: "GET handler",
              domain: "core",
              tags: ["get"],
              supportLevel: "stable",
              requiredPackages: ["opentool"],
              requiredEnv: [],
              updatedAt: "2026-05-12",
            },
          ],
        });
      }
      if (url.pathname === "/v1/opentool/recipes/search") {
        return Response.json({
          matches: [
            {
              id: "core/basic-get-tool",
              title: "Basic GET",
              score: 10,
              reason: "Matched scheduled digest",
              snippetsAvailable: ["tools/digest.ts"],
              warnings: [],
            },
          ],
        });
      }
      if (url.pathname === "/v1/opentool/recipes/core%2Fbasic-get-tool") {
        return Response.json({
          id: "core/basic-get-tool",
          title: "Basic GET",
          summary: "GET handler",
          domain: "core",
          tags: ["get"],
          supportLevel: "stable",
          requiredPackages: ["opentool"],
          requiredEnv: [],
          updatedAt: "2026-05-12",
          goal: "Create a GET handler",
          rules: ["Export GET"],
          files: [{ pathHint: "tools/digest.ts", purpose: "example", code: "export async function GET() { return Response.json({ ok: true }); }" }],
          tests: [],
          validationChecklist: ["Run validate"],
          dependencies: ["opentool"],
          env: [],
          failureModes: [],
          sources: [],
        });
      }
      if (url.pathname === "/v1/opentool/rules") {
        return Response.json({
          topic: "build-validate",
          rules: ["Validate first"],
          commonMistakes: [],
          diagnostics: [],
          examples: [],
          nextActions: ["Run validate"],
        });
      }
      return Response.json({ error: "not_found", path: url.pathname }, { status: 404 });
    };

    try {
      await api(instance.url, instance.token, "/v1/openpond/accounts/login", {
        method: "POST",
        body: JSON.stringify({
          handle: "recipe-test",
          apiKey: "test-token",
          baseUrl: "https://openpond.ai",
          apiBaseUrl: "https://api.test",
          setActive: true,
        }),
      });
      const session = await api(instance.url, instance.token, "/v1/sessions", {
        method: "POST",
        body: JSON.stringify({ provider: "openpond", title: "recipe tools" }),
      });

      const list = await api(instance.url, instance.token, `/v1/sessions/${session.id}/workspace-tools`, {
        method: "POST",
        body: JSON.stringify({ action: "opentool_recipe_list", args: { domain: "core" } }),
      });
      assert.equal(list.ok, true, list.output);
      assert.equal(list.data.recipes[0].id, "core/basic-get-tool");

      const search = await api(instance.url, instance.token, `/v1/sessions/${session.id}/workspace-tools`, {
        method: "POST",
        body: JSON.stringify({ action: "opentool_recipe_search", args: { query: "scheduled digest" } }),
      });
      assert.equal(search.ok, true, search.output);
      assert.equal(search.data.matches[0].id, "core/basic-get-tool");

      const recipe = await api(instance.url, instance.token, `/v1/sessions/${session.id}/workspace-tools`, {
        method: "POST",
        body: JSON.stringify({ action: "opentool_recipe_get", args: { id: "core/basic-get-tool" } }),
      });
      assert.equal(recipe.ok, true, recipe.output);
      assert.match(recipe.data.files[0].code, /GET/);

      const rules = await api(instance.url, instance.token, `/v1/sessions/${session.id}/workspace-tools`, {
        method: "POST",
        body: JSON.stringify({ action: "opentool_rules_get", args: { topic: "build-validate", errorText: "validate failed" } }),
      });
      assert.equal(rules.ok, true, rules.output);
      assert.equal(rules.data.topic, "build-validate");

      const bootstrap = await api(instance.url, instance.token, "/v1/bootstrap");
      for (const action of ["opentool_recipe_list", "opentool_recipe_search", "opentool_recipe_get", "opentool_rules_get"]) {
        assert.ok(
          bootstrap.events.some(
            (event) =>
              event.sessionId === session.id &&
              event.name === "workspace_action_result" &&
              event.action === action &&
              event.status === "completed"
          ),
          `${action} should complete`
        );
      }
      assert.ok(calls.some((call) => call.pathname === "/v1/opentool/recipes/search"));
    } finally {
      globalThis.fetch = originalFetch;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await instance.close();
      await rm(storeDir, { recursive: true, force: true });
    }
  });

  test.skip("runs the managed OpenPond edit pipeline for eligible hosted workspaces", async () => {
    const storeDir = await mkdtemp(path.join(os.tmpdir(), "openpond-managed-pipeline-test-"));
    const previousHome = process.env.HOME;
    const originalFetch = globalThis.fetch;
    process.env.HOME = storeDir;
    const bareRemote = path.join(storeDir, "managed-remote.git");
    await git(storeDir, ["init", "--bare", bareRemote]);
    await git(storeDir, [
      "config",
      "--global",
      `url.file://${bareRemote}.insteadOf`,
      "https://openpond.ai/openpondai/managed-pipeline.git",
    ]);
    const instance = await createOpenPondServer({ port: 0, storeDir, silent: true });
    const deployments = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.origin === "https://api.test" && url.pathname === "/health") {
        return Response.json({ ok: true, authenticated: true });
      }
      if (url.origin === "https://api.test" && url.pathname === "/account") {
        return Response.json({ account: { id: "acct_1", handle: "managed-test" } });
      }
      if (url.origin === "https://api.test" && url.pathname === "/apps/list") {
        return Response.json({ apps: [] });
      }
      if (url.origin === "https://api.test" && url.pathname === "/apps/repo/create") {
        return Response.json({
          appId: "app_managed_pipeline",
          gitOwner: "openpondai",
          gitRepo: "managed-pipeline",
          gitHost: "openpond.ai",
          repoUrl: "https://openpond.ai/openpondai/managed-pipeline.git",
          defaultBranch: "main",
        });
      }
      if (url.origin === "https://api.test" && url.pathname.includes("/deployments")) {
        deployments.push({ path: url.pathname, body: JSON.parse(String(init?.body ?? "{}")) });
        return Response.json({ deploymentId: "deployment_managed_preview" });
      }
      return originalFetch(input, init);
    };

    try {
      await api(instance.url, instance.token, "/v1/openpond/accounts/login", {
        method: "POST",
        body: JSON.stringify({
          handle: "managed-test",
          apiKey: "test-token",
          baseUrl: "https://openpond.ai",
          apiBaseUrl: "https://api.test",
          setActive: true,
        }),
      });

      const session = await api(instance.url, instance.token, "/v1/sessions", {
        method: "POST",
        body: JSON.stringify({ provider: "openpond", title: "managed pipeline" }),
      });
      const scaffold = await api(instance.url, instance.token, `/v1/sessions/${session.id}/workspace-tools`, {
        method: "POST",
        body: JSON.stringify({
          action: "create_scaffold",
          args: {
            name: "Managed Pipeline Agent",
            mode: "hosted",
          },
        }),
      });
      assert.equal(scaffold.ok, true, scaffold.output);

      const repoPath = scaffold.data.workspace.repoPath;
      const packageJsonPath = path.join(repoPath, "package.json");
      const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
      packageJson.scripts = {
        ...packageJson.scripts,
        validate: "node -e \"console.log('validate ok')\"",
        build: "node -e \"console.log('build ok')\"",
      };
      await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
      await git(repoPath, ["add", "package.json"]);
      await git(repoPath, ["commit", "-m", "Use deterministic test checks"]);
      await git(repoPath, ["push", "--set-upstream", "origin", scaffold.data.workspace.currentBranch]);

      const write = await api(instance.url, instance.token, `/v1/sessions/${session.id}/workspace-tools`, {
        method: "POST",
        body: JSON.stringify({
          action: "write_file",
          args: {
            path: "tools/managed.ts",
            content: "export async function GET() { return Response.json({ managed: true }); }\n",
          },
        }),
      });
      assert.equal(write.ok, true, write.output);
      assert.equal(write.data.managed.status, "preview_started");
      assert.equal(write.data.managed.preview.deploymentId, "deployment_managed_preview");
      assert.equal(deployments.length, 1);
      assert.equal(deployments[0].body.environment, "preview");
      assert.match(deployments[0].body.commitSha, /^[a-f0-9]{40}$/);

      const bootstrap = await api(instance.url, instance.token, "/v1/bootstrap");
      for (const action of ["validate_opentool", "build_opentool", "git_commit", "git_push", "deploy_preview"]) {
        assert.ok(
          bootstrap.events.some(
            (event) =>
              event.sessionId === session.id &&
              event.name === "workspace_action_result" &&
              event.action === action &&
              event.status === "completed"
          ),
          `${action} should complete`
        );
      }
    } finally {
      globalThis.fetch = originalFetch;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await instance.close();
      await rm(storeDir, { recursive: true, force: true });
    }
  });

  test.skip("runs a deployed OpenTool tool through the persisted OpenPond execution API", async () => {
    const storeDir = await mkdtemp(path.join(os.tmpdir(), "openpond-run-tool-test-"));
    const previousHome = process.env.HOME;
    const originalFetch = globalThis.fetch;
    process.env.HOME = storeDir;
    const instance = await createOpenPondServer({ port: 0, storeDir, silent: true });
    const calls = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.origin !== "https://api.test") return originalFetch(input, init);
      calls.push({ pathname: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.pathname === "/health") {
        return Response.json({ ok: true, authenticated: true });
      }
      if (url.pathname === "/account") {
        return Response.json({ account: { id: "acct_1", handle: "run-tool-test" }, products: [] });
      }
      if (url.pathname === "/apps/list") {
        return Response.json({ apps: [] });
      }
      if (url.pathname === "/apps/tools/execute") {
        assert.deepEqual(JSON.parse(String(init?.body ?? "{}")), {
          appId: "app_tool_run",
          deploymentId: "deployment_tool_run",
          toolName: "prompt-agent",
          method: "POST",
          body: { prompt: "search the web for ai news" },
          notifyEmail: false,
        });
        return Response.json({
          run: {
            id: "tool_run_1",
            deploymentId: "deployment_tool_run",
            toolName: "prompt-agent",
            status: "completed",
            statusCode: 200,
          },
          data: { markdown: "AI news summary" },
        });
      }
      return Response.json({ error: "not_found", path: url.pathname }, { status: 404 });
    };

    try {
      await api(instance.url, instance.token, "/v1/openpond/accounts/login", {
        method: "POST",
        body: JSON.stringify({
          handle: "run-tool-test",
          apiKey: "test-token",
          baseUrl: "https://openpond.ai",
          apiBaseUrl: "https://api.test",
          setActive: true,
        }),
      });
      const session = await api(instance.url, instance.token, "/v1/sessions", {
        method: "POST",
        body: JSON.stringify({
          provider: "openpond",
          title: "run tool",
          appId: "app_tool_run",
          appName: "Tool Run App",
        }),
      });
      const result = await api(instance.url, instance.token, `/v1/sessions/${session.id}/workspace-tools`, {
        method: "POST",
        body: JSON.stringify({
          action: "run_opentool_tool",
          args: {
            toolName: "prompt-agent",
            deploymentId: "deployment_tool_run",
            body: { prompt: "search the web for ai news" },
          },
        }),
      });
      assert.equal(result.ok, true, result.output);
      assert.equal(result.data.deploymentId, "deployment_tool_run");
      assert.equal(result.data.result.data.run.id, "tool_run_1");
      assert.ok(calls.some((call) => call.pathname === "/apps/tools/execute"));

      const bootstrap = await api(instance.url, instance.token, "/v1/bootstrap");
      assert.ok(
        bootstrap.events.some(
          (event) =>
            event.sessionId === session.id &&
            event.name === "workspace_action_result" &&
            event.action === "run_opentool_tool" &&
            event.status === "completed"
        )
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await instance.close();
      await rm(storeDir, { recursive: true, force: true });
    }
  });

  test.skip("runs a deployed OpenTool tool by appUrl from a project chat", async () => {
    const storeDir = await mkdtemp(path.join(os.tmpdir(), "openpond-run-tool-app-name-test-"));
    const previousHome = process.env.HOME;
    const originalFetch = globalThis.fetch;
    process.env.HOME = storeDir;
    const instance = await createOpenPondServer({ port: 0, storeDir, silent: true });
    const calls = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.origin !== "https://api.test") return originalFetch(input, init);
      calls.push({ pathname: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.pathname === "/health") {
        return Response.json({ ok: true, authenticated: true });
      }
      if (url.pathname === "/account") {
        return Response.json({ account: { id: "acct_1", handle: "run-tool-app-name-test" }, products: [] });
      }
      if (url.pathname === "/apps/list") {
        return Response.json({
          apps: [
            {
              id: "app_mpp_service_tool",
              name: "mpp-service-tool",
              gitRepo: "mpp-service-tool",
              latestDeployment: { id: "deployment_mpp_service_tool", status: "completed" },
            },
          ],
        });
      }
      if (url.pathname === "/apps/tools/execute") {
        assert.deepEqual(JSON.parse(String(init?.body ?? "{}")), {
          appId: "app_mpp_service_tool",
          deploymentId: "deployment_mpp_service_tool",
          toolName: "mpp-service-tool",
          method: "POST",
          body: {},
          notifyEmail: false,
        });
        return Response.json({
          run: {
            id: "tool_run_mpp",
            deploymentId: "deployment_mpp_service_tool",
            toolName: "mpp-service-tool",
            status: "completed",
            statusCode: 400,
          },
          data: { ok: false, error: "Configure an MPP service or pass serviceUrl." },
        });
      }
      return Response.json({ error: "not_found", path: url.pathname }, { status: 404 });
    };

    try {
      await api(instance.url, instance.token, "/v1/openpond/accounts/login", {
        method: "POST",
        body: JSON.stringify({
          handle: "run-tool-app-name-test",
          apiKey: "test-token",
          baseUrl: "https://openpond.ai",
          apiBaseUrl: "https://api.test",
          setActive: true,
        }),
      });
      const session = await api(instance.url, instance.token, "/v1/sessions", {
        method: "POST",
        body: JSON.stringify({
          provider: "openpond",
          title: "run mpp tool",
          appId: null,
          workspaceKind: "local_project",
          workspaceId: "local_project_1",
          workspaceName: "Local project",
          cwd: storeDir,
        }),
      });
      const result = await api(instance.url, instance.token, `/v1/sessions/${session.id}/workspace-tools`, {
        method: "POST",
        body: JSON.stringify({
          action: "run_opentool_tool",
          args: {
            appUrl: "https://staging.openpond.ai/openpondai/mpp-service-tool",
            deploymentId: "deployment_mpp_service_tool",
            body: {},
          },
        }),
      });
      assert.equal(result.ok, true, result.output);
      assert.equal(result.appId, "app_mpp_service_tool");
      assert.equal(result.data.appId, "app_mpp_service_tool");
      assert.equal(result.data.result.data.run.id, "tool_run_mpp");
      assert.ok(calls.some((call) => call.pathname === "/apps/list"));
      assert.ok(calls.some((call) => call.pathname === "/apps/tools/execute"));
    } finally {
      globalThis.fetch = originalFetch;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await instance.close();
      await rm(storeDir, { recursive: true, force: true });
    }
  });

  test.skip("emits runtime events and server log records for immediate automation run now", async () => {
    const storeDir = await mkdtemp(path.join(os.tmpdir(), "openpond-automation-run-log-test-"));
    const previousHome = process.env.HOME;
    const originalFetch = globalThis.fetch;
    process.env.HOME = storeDir;
    const instance = await createOpenPondServer({ port: 0, storeDir, silent: true });
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.origin === "https://api.test" && url.pathname === "/health") {
        return Response.json({ ok: true, authenticated: true });
      }
      if (url.origin === "https://api.test" && url.pathname === "/account") {
        return Response.json({ account: { id: "acct_1", handle: "run-test" } });
      }
      if (url.origin === "https://api.test" && url.pathname === "/apps/list") {
        return Response.json({ apps: [] });
      }
      if (url.pathname === "/apps/app_1/schedules") {
        return Response.json({
          schedules: [
            {
              id: "schedule_1",
              name: "prompt-agent",
              description: null,
              scheduleType: "cron",
              scheduleExpression: "0 9 * * 1-5",
              enabled: true,
              syncStatus: "synced",
              startAt: null,
              endAt: null,
              maxRuns: null,
              executionCount: 0,
              lifecycleStatus: "active",
              lifecycleReason: null,
              updatedAt: new Date().toISOString(),
              deploymentId: "deployment_1",
              payload: {
                method: "GET",
                path: "/prompt-agent",
                tool: "prompt-agent",
              },
            },
          ],
        });
      }
      if (url.pathname === "/apps/tools/execute") {
        assert.deepEqual(JSON.parse(String(init?.body ?? "{}")), {
          appId: "app_1",
          deploymentId: "deployment_1",
          toolName: "prompt-agent",
          scheduleId: "schedule_1",
          method: "GET",
        });
        return Response.json({
          ok: true,
          status: 200,
          data: { output: "scheduled output" },
          runId: "tool_run_1",
        });
      }
      return originalFetch(input, init);
    };

    try {
      await api(instance.url, instance.token, "/v1/openpond/accounts/login", {
        method: "POST",
        body: JSON.stringify({
          handle: "run-test",
          apiKey: "test-token",
          baseUrl: "https://openpond.ai",
          apiBaseUrl: "https://api.test",
          setActive: true,
        }),
      });

      const result = await api(instance.url, instance.token, "/v1/automations/app_1/schedules/schedule_1/run", {
        method: "POST",
        body: JSON.stringify({}),
      });
      assert.equal(result.ok, true);
      assert.equal(result.toolName, "prompt-agent");
      assert.equal(result.runId, "tool_run_1");

      const bootstrap = await api(instance.url, instance.token, "/v1/bootstrap");
      assert.ok(
        bootstrap.events.some(
          (event) =>
            event.name === "workspace_action_result" &&
            event.action === "run_schedule" &&
            event.appId === "app_1" &&
            event.status === "completed"
        )
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await instance.close();
    }

    const serverLog = await readFile(path.join(storeDir, "logs", "server.log"), "utf8");
    assert.match(serverLog, /workspace action completed/);
    assert.match(serverLog, /run_schedule/);
    await rm(storeDir, { recursive: true, force: true });
  });
});
