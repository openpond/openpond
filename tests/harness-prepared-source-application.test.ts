import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  applyPreparedHarnessSourceApplication,
  HARNESS_PREPARED_SOURCE_MANIFEST,
  type LocalCreatePipelineTarget,
} from "../apps/server/src/runtime/local-create-pipeline";
import { createImproveRunFixture } from "./helpers/create-improve-fixtures";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

describe("prepared harness source application", () => {
  test("applies the selected source and registration files only in scripted harness mode", async () => {
    const fixture = await sourceFixture();
    const run = createImproveRunFixture({
      operation: "create",
      target: {
        kind: "agent",
        id: "account-health-agent",
        displayName: "Account Health Agent",
        defaultActionKey: "account-health-agent.chat",
      },
    });

    await expect(applyPreparedHarnessSourceApplication(
      run,
      fixture.target,
      { OPENPOND_HARNESS_SCRIPTED_MODELS: "1" },
    )).resolves.toBe(true);
    await expect(readFile(path.join(fixture.target.sourceRoot, "agent", "agent.ts"), "utf8"))
      .resolves.toBe("export const fixture = true;\n");
    await expect(readFile(path.join(fixture.root, "openpond-profile.json"), "utf8"))
      .resolves.toBe("{\"enabled\":true}\n");
  });

  test("does not expose prepared source application outside explicit harness mode", async () => {
    const fixture = await sourceFixture();
    const run = createImproveRunFixture({
      operation: "create",
      target: {
        kind: "agent",
        id: "account-health-agent",
        displayName: "Account Health Agent",
        defaultActionKey: "account-health-agent.chat",
      },
    });

    await expect(applyPreparedHarnessSourceApplication(run, fixture.target, {})).resolves.toBe(false);
    await expect(readFile(path.join(fixture.target.sourceRoot, "agent", "agent.ts"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects manifest paths that leave the isolated profile repo", async () => {
    const fixture = await sourceFixture();
    await writeFile(
      path.join(fixture.root, HARNESS_PREPARED_SOURCE_MANIFEST),
      `${JSON.stringify({
        schema: "openpond.harnessPreparedSource.v1",
        agents: {
          "account-health-agent": {
            create: { source: "../outside" },
          },
        },
      })}\n`,
      "utf8",
    );
    const run = createImproveRunFixture({
      operation: "create",
      target: {
        kind: "agent",
        id: "account-health-agent",
        displayName: "Account Health Agent",
        defaultActionKey: "account-health-agent.chat",
      },
    });

    await expect(applyPreparedHarnessSourceApplication(
      run,
      fixture.target,
      { OPENPOND_HARNESS_SCRIPTED_MODELS: "1" },
    )).rejects.toThrow("must stay inside the profile repo");
  });
});

async function sourceFixture(): Promise<{
  root: string;
  target: LocalCreatePipelineTarget;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "openpond-harness-prepared-source-"));
  directories.push(root);
  const profileSource = path.join(root, "profiles", "default");
  const template = path.join(root, "fixtures", "base");
  await mkdir(path.join(template, "agent"), { recursive: true });
  await mkdir(path.join(root, "fixtures", "registration"), { recursive: true });
  await mkdir(profileSource, { recursive: true });
  await writeFile(path.join(template, "agent", "agent.ts"), "export const fixture = true;\n", "utf8");
  await writeFile(path.join(root, "fixtures", "registration", "openpond-profile.json"), "{\"enabled\":true}\n", "utf8");
  await writeFile(
    path.join(root, HARNESS_PREPARED_SOURCE_MANIFEST),
    `${JSON.stringify({
      schema: "openpond.harnessPreparedSource.v1",
      agents: {
        "account-health-agent": {
          create: {
            source: "fixtures/base",
            registrations: [{
              source: "fixtures/registration/openpond-profile.json",
              target: "openpond-profile.json",
            }],
          },
        },
      },
    }, null, 2)}\n`,
    "utf8",
  );
  return {
    root,
    target: {
      activeProfile: "default",
      agentId: "account-health-agent",
      defaultAction: "chat",
      repoPath: root,
      sourcePath: profileSource,
      workspaceRoot: root,
      profileRelativePath: "profiles/default",
      sourceRoot: path.join(profileSource, "agents", "account-health-agent"),
      sourceRootRelativePath: "profiles/default/agents/account-health-agent",
    },
  };
}
