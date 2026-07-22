import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  createGithubExtensionManager,
  parseGithubExtensionSource,
} from "../packages/cloud/src/extensions/index";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("GitHub extension manager", () => {
  test("previews, installs, lists, updates, and removes a multi-skill repository", async () => {
    const rootPath = await temporaryRoot();
    const fixture = githubFixture();
    const manager = createGithubExtensionManager({
      rootPath,
      fetch: fixture.fetch,
      now: () => new Date("2026-07-22T12:00:00.000Z"),
    });

    const preview = await manager.preview({ source: "acme/pond-skills" });
    expect(preview).toMatchObject({
      id: "github:acme/pond-skills",
      requestedRef: "HEAD",
      resolvedCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      validationStatus: "valid",
    });
    expect(preview.skills.map((skill) => skill.name)).toEqual(["deploy-check", "release-notes", "review-checklist"]);
    expect(preview.skills.find((skill) => skill.name === "release-notes")?.resourceFiles)
      .toEqual(["references/example.md", "scripts/linked.sh"]);

    const installed = await manager.add({ source: "https://github.com/acme/pond-skills" });
    expect(installed.sourcePath).toBe(path.join(rootPath, "github", "acme", "pond-skills", "current"));
    await expect(readFile(path.join(installed.sourcePath, "skills/release-notes/SKILL.md"), "utf8"))
      .resolves.toContain("Release Notes");
    await expect(readFile(path.join(rootPath, "registry.json"), "utf8"))
      .resolves.toContain("github:acme/pond-skills");

    const catalog = await manager.list();
    expect(catalog.error).toBeNull();
    expect(catalog.extensions).toHaveLength(1);
    expect(catalog.extensions[0]?.skills).toHaveLength(3);
    await expect(manager.readSkill("release-notes")).resolves.toMatchObject({
      name: "release-notes",
      body: "# Release Notes",
      packagePath: path.join(installed.sourcePath, "skills", "release-notes"),
      resourceFiles: ["references/example.md", "scripts/linked.sh"],
    });

    fixture.version = 2;
    const updated = await manager.update({ source: "acme/pond-skills" });
    expect(updated.resolvedCommit).toBe("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    await expect(readFile(path.join(updated.sourcePath, "skills/release-notes/SKILL.md"), "utf8"))
      .resolves.toContain("Updated release notes");
    await expect(manager.readSkill("release-notes")).resolves.toMatchObject({
      body: "# Updated release notes",
    });

    const removed = await manager.remove("acme/pond-skills");
    expect(removed.id).toBe("github:acme/pond-skills");
    expect((await manager.list()).extensions).toEqual([]);
  });

  test("rejects skill names reserved by shipped OpenPond skills", async () => {
    const manager = createGithubExtensionManager({
      rootPath: await temporaryRoot(),
      fetch: githubFixture({ firstSkillName: "openpond-cli" }).fetch,
      reservedSkillNames: ["openpond-cli"],
    });

    await expect(manager.preview({ source: "acme/pond-skills" }))
      .rejects.toThrow("Skill name conflict: openpond-cli");
  });

  test("rejects symlinked skill resources before downloading repository files", async () => {
    const fixture = githubFixture({ symlink: true });
    const manager = createGithubExtensionManager({ rootPath: await temporaryRoot(), fetch: fixture.fetch });

    await expect(manager.add({ source: "acme/pond-skills" }))
      .rejects.toThrow("contains a symlink or submodule");
  });

  test("normalizes supported GitHub repository inputs", () => {
    expect(parseGithubExtensionSource("github:OpenPond/Example.git")).toMatchObject({
      id: "github:openpond/example",
      repositoryUrl: "https://github.com/openpond/example",
    });
    expect(parseGithubExtensionSource("https://github.com/Owner/Repo")).toMatchObject({
      owner: "owner",
      repo: "repo",
    });
    expect(() => parseGithubExtensionSource("https://gitlab.com/owner/repo")).toThrow("Invalid GitHub extension source");
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "openpond-extensions-"));
  tempRoots.push(root);
  return root;
}

function githubFixture(options: { firstSkillName?: string; symlink?: boolean } = {}) {
  const fixture = { version: 1, fetch: null as unknown as typeof fetch };
  fixture.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const commit = fixture.version === 1
      ? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      : "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const treeSha = fixture.version === 1
      ? "1111111111111111111111111111111111111111"
      : "2222222222222222222222222222222222222222";
    if (url.hostname === "api.github.com" && url.pathname === "/repos/acme/pond-skills") {
      return jsonResponse({ default_branch: "main" });
    }
    if (url.hostname === "api.github.com" && url.pathname === "/repos/acme/pond-skills/commits/main") {
      return jsonResponse({ sha: commit, commit: { tree: { sha: treeSha } } });
    }
    if (url.hostname === "api.github.com" && url.pathname === `/repos/acme/pond-skills/git/trees/${treeSha}`) {
      return jsonResponse({
        truncated: false,
        tree: [
          treeEntry("README.md", "readme", 20),
          treeEntry("skills/release-notes/SKILL.md", "release-skill", 140),
          treeEntry("skills/release-notes/references/example.md", "release-reference", 20),
          treeEntry(
            "skills/release-notes/scripts/linked.sh",
            "release-link",
            8,
            options.symlink ? "120000" : "100755",
          ),
          treeEntry("skills/review-checklist/SKILL.md", "review-skill", 130),
          treeEntry(".agents/skills/catalog/deploy-check/SKILL.md", "deploy-skill", 120),
        ],
      });
    }
    if (url.hostname === "raw.githubusercontent.com") {
      const filePath = decodeURIComponent(url.pathname.split(`/${commit}/`)[1] ?? "");
      const firstName = options.firstSkillName ?? "release-notes";
      const files: Record<string, string> = {
        "README.md": "# Pond skills\n",
        "skills/release-notes/SKILL.md": [
          "---",
          `name: ${firstName}`,
          "description: Prepare reliable release notes.",
          "---",
          "",
          fixture.version === 1 ? "# Release Notes" : "# Updated release notes",
        ].join("\n"),
        "skills/release-notes/references/example.md": "# Example\n",
        "skills/release-notes/scripts/linked.sh": "echo ok\n",
        "skills/review-checklist/SKILL.md": [
          "---",
          "name: review-checklist",
          "description: Review a change with the team checklist.",
          "---",
          "",
          "# Review checklist",
        ].join("\n"),
        ".agents/skills/catalog/deploy-check/SKILL.md": [
          "---",
          "name: deploy-check",
          "description: Check a deployment before release.",
          "---",
          "",
          "# Deploy check",
        ].join("\n"),
      };
      const body = files[filePath];
      return body === undefined ? new Response("missing", { status: 404 }) : new Response(body, { status: 200 });
    }
    return new Response("missing fixture", { status: 404 });
  };
  return fixture;
}

function treeEntry(pathValue: string, sha: string, size: number, mode = "100644") {
  return { path: pathValue, mode, type: "blob", sha, size };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
