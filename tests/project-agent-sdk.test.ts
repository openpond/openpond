import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";

import { detectProjectAgentSdk } from "../apps/server/src/workspace/project-agent-sdk";

async function withTempProject(fn: (projectDir: string) => Promise<void>) {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "openpond-agent-sdk-test-"));
  try {
    await fn(projectDir);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

describe("project agent SDK detection", () => {
  test("detects openpond-agent-sdk in a root package manifest", async () => {
    await withTempProject(async (projectDir) => {
      const manifestPath = path.join(projectDir, "package.json");
      await writeFile(
        manifestPath,
        `${JSON.stringify({ dependencies: { "openpond-agent-sdk": "^1.2.3" } })}\n`,
        "utf8",
      );

      const detected = await detectProjectAgentSdk({
        selectedPath: projectDir,
        workspacePath: projectDir,
      });

      expect(detected).toEqual({
        detected: true,
        packageName: "openpond-agent-sdk",
        rootPath: projectDir,
        manifestPath,
        version: "^1.2.3",
        dependencyType: "dependencies",
      });
    });
  });

  test("detects openpond-agent-sdk in a nested workspace package", async () => {
    await withTempProject(async (projectDir) => {
      const packageDir = path.join(projectDir, "apps", "agent");
      await mkdir(packageDir, { recursive: true });
      await writeFile(
        path.join(projectDir, "package.json"),
        `${JSON.stringify({ private: true, workspaces: ["apps/*"] })}\n`,
        "utf8",
      );
      await writeFile(
        path.join(packageDir, "package.json"),
        `${JSON.stringify({ devDependencies: { "openpond-agent-sdk": "workspace:*" } })}\n`,
        "utf8",
      );

      const detected = await detectProjectAgentSdk({
        selectedPath: projectDir,
        workspacePath: projectDir,
      });

      expect(detected?.rootPath).toBe(packageDir);
      expect(detected?.version).toBe("workspace:*");
      expect(detected?.dependencyType).toBe("devDependencies");
    });
  });

  test("ignores projects without an openpond-agent-sdk dependency", async () => {
    await withTempProject(async (projectDir) => {
      await writeFile(
        path.join(projectDir, "package.json"),
        `${JSON.stringify({ dependencies: { react: "^19.0.0" } })}\n`,
        "utf8",
      );

      await expect(
        detectProjectAgentSdk({
          selectedPath: projectDir,
          workspacePath: projectDir,
        }),
      ).resolves.toBeNull();
    });
  });
});
