import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { OpenPondSandboxClient } from "@openpond/cloud";
import { describe, expect, test, vi } from "vitest";

import { materializeHostedProfileAgentSource } from "../packages/cloud/src/profile/hosted-agent-materialization";
import { emptyOpenPondProfileState } from "../packages/contracts/src";

describe("hosted profile agent materialization", () => {
  test("uploads Agent SDK source and upserts the runnable Team agent", async () => {
    const sourceRoot = await mkdtemp(
      path.join(os.tmpdir(), "openpond-hosted-agent-materialization-"),
    );
    try {
      await cp(
        path.resolve("packages/agent-sdk/templates/blank-agent"),
        sourceRoot,
        { recursive: true },
      );
      await pointTemplateAtWorkspaceAgentSdk(sourceRoot);

      const materializedProject = sandboxProject({
        id: "project_materialized",
      });
      const uploadedProject = sandboxProject({
        id: "project_materialized",
        sourceConfig: {
          sourceRef: "main",
          sourceCommitSha: "source_uploaded",
        },
      });
      const syncedProject = sandboxProject({
        id: "project_materialized",
        sourceConfig: {
          sourceRef: "main",
          sourceCommitSha: "source_synced",
        },
        sandboxManifestHash: "manifest_hash",
        sandboxManifestPath: "openpond.yaml",
        sandboxManifestSyncedAt: "2026-07-18T12:00:00.000Z",
      });
      const projectUpsert = vi.fn(async () => materializedProject);
      const uploadSource = vi.fn(async () => uploadedProject);
      const syncProject = vi.fn(async () => syncedProject);
      const agentUpsert = vi.fn(async () => ({
        id: "runtime_expense_review",
      }));
      const client = {
        projects: {
          get: vi.fn(),
          upsert: projectUpsert,
          uploadSource,
          sync: syncProject,
        },
        agents: {
          upsert: agentUpsert,
        },
      } as unknown as OpenPondSandboxClient;
      const profile = {
        ...emptyOpenPondProfileState(),
        mode: "local" as const,
        activeProfile: "default",
        sourcePath: sourceRoot,
        agents: [
          {
            id: "expense-review",
            name: "Expense Review",
            path: "agent/agent.ts",
            enabled: true,
          },
        ],
      };

      const result = await materializeHostedProfileAgentSource({
        client,
        teamId: "team_1",
        profileProjectId: "profile_project",
        profileName: "default",
        state: profile,
        agentId: "expense-review",
        sourceRef: "main",
        localHead: "local_head",
        hostedHead: "hosted_head",
      });

      expect(projectUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          teamId: "team_1",
          sourceType: "manual",
          externalId:
            "openpond-profile:profile_project:default:expense-review",
        }),
      );
      expect(uploadSource).toHaveBeenCalledWith(
        "project_materialized",
        expect.objectContaining({
          teamId: "team_1",
          branch: "main",
          entries: expect.arrayContaining([
            expect.objectContaining({ path: "agent/agent.ts" }),
            expect.objectContaining({ path: "openpond.yaml" }),
          ]),
        }),
      );
      expect(agentUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          teamId: "team_1",
          projectId: "project_materialized",
          name: "Expense Review",
          selectedEntrypoint: { scope: "action", name: "chat" },
          runtimeSource: {
            mode: "latest_source",
            sourceRef: "main",
            sourceCommitSha: "source_synced",
          },
        }),
      );
      expect(result).toMatchObject({
        status: "uploaded",
        agentId: "expense-review",
        runtimeAgentId: "runtime_expense_review",
        projectId: "project_materialized",
        sourceRef: "main",
        sourceCommitSha: "source_synced",
        manifestHash: "manifest_hash",
      });
      expect(result.fileCount).toBeGreaterThan(0);
      expect(result.totalBytes).toBeGreaterThan(0);
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
    }
  }, 60_000);
});

async function pointTemplateAtWorkspaceAgentSdk(
  sourceRoot: string,
): Promise<void> {
  const packageJsonPath = path.join(sourceRoot, "package.json");
  const packageJson = JSON.parse(
    await readFile(packageJsonPath, "utf8"),
  ) as {
    dependencies: Record<string, string>;
  };
  packageJson.dependencies["openpond-agent-sdk"] =
    `file:${path.resolve("packages/agent-sdk")}`;
  await writeFile(
    packageJsonPath,
    `${JSON.stringify(packageJson, null, 2)}\n`,
    "utf8",
  );
  const nodeModulesPath = path.join(sourceRoot, "node_modules");
  await mkdir(nodeModulesPath, { recursive: true });
  await symlink(
    path.resolve("packages/agent-sdk"),
    path.join(nodeModulesPath, "openpond-agent-sdk"),
    "dir",
  );
}

function sandboxProject(
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: "project_materialized",
    sourceConfig: {},
    metadata: {},
    sandboxManifestHash: null,
    sandboxManifestPath: null,
    sandboxManifestSyncedAt: null,
    ...overrides,
  };
}
