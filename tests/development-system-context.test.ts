import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { Session } from "@openpond/contracts";
import { createHostedTurnHelpers } from "../apps/server/src/openpond/hosted-turn-helpers";
import {
  buildRepositoryInstructionContext,
  resolveRepositoryInstructions,
} from "../apps/server/src/openpond/repository-instructions";
import { runWorkspaceCommand } from "../apps/server/src/workspace/workspace-command";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("Development repository instructions", () => {
  test("loads root-to-working-directory instructions and prefers overrides", async () => {
    const repositoryRoot = await createGitRepository();
    const packageDirectory = path.join(repositoryRoot, "packages");
    const workingDirectory = path.join(packageDirectory, "app");
    await mkdir(workingDirectory, { recursive: true });
    await writeFile(
      path.join(repositoryRoot, "AGENTS.md"),
      "Root instructions.",
    );
    await writeFile(
      path.join(packageDirectory, "AGENTS.md"),
      "Ignored package instructions.",
    );
    await writeFile(
      path.join(packageDirectory, "AGENTS.override.md"),
      "Package override instructions.",
    );
    await writeFile(
      path.join(workingDirectory, "AGENTS.md"),
      "App instructions.",
    );

    const resolution = await resolveRepositoryInstructions(workingDirectory);

    expect(resolution?.sources.map((source) => source.relativePath)).toEqual([
      "AGENTS.md",
      path.join("packages", "AGENTS.override.md"),
      path.join("packages", "app", "AGENTS.md"),
    ]);
    expect(resolution?.sources.map((source) => source.content)).toEqual([
      "Root instructions.",
      "Package override instructions.",
      "App instructions.",
    ]);
    expect(buildRepositoryInstructionContext(resolution)).not.toContain(
      "Ignored package instructions.",
    );
  });

  test("does not follow repository instruction symlinks outside the repository", async () => {
    const temporaryRoot = await createTemporaryRoot();
    const repositoryRoot = path.join(temporaryRoot, "repository");
    await mkdir(repositoryRoot);
    await initializeGitRepository(repositoryRoot);
    const outsideInstructions = path.join(
      temporaryRoot,
      "outside-instructions.md",
    );
    await writeFile(outsideInstructions, "Outside instructions.");
    await writeFile(path.join(repositoryRoot, "AGENTS.md"), "Safe instructions.");
    await symlink(
      outsideInstructions,
      path.join(repositoryRoot, "AGENTS.override.md"),
    );

    const resolution = await resolveRepositoryInstructions(repositoryRoot);

    expect(resolution?.sources.map((source) => source.relativePath)).toEqual([
      "AGENTS.md",
    ]);
    expect(resolution?.diagnostics).toEqual([
      expect.stringContaining("outside the repository boundary"),
    ]);
  });

  test("adds persistence, destructive-action safety, and AGENTS.md to repository-aware Work", async () => {
    const repositoryRoot = await createGitRepository();
    await writeFile(
      path.join(repositoryRoot, "AGENTS.md"),
      "Use ./cli --staging changes --run for staging.",
    );
    const helpers = createHostedTurnHelpers({
      appendRuntimeEvent: async () => undefined,
    });

    const developmentPrompt = await helpers.hostedSystemPrompt(
      "Base prompt.",
      "",
      session({
        experience: "development",
        workspaceKind: "local_project",
        cwd: repositoryRoot,
      }),
      { toolInstructionMode: "none" },
    );
    const chatPrompt = await helpers.hostedSystemPrompt(
      "Base prompt.",
      "",
      session({
        experience: "chat",
        workspaceKind: "local_project",
        cwd: repositoryRoot,
      }),
      { toolInstructionMode: "none" },
    );
    const workPrompt = await helpers.hostedSystemPrompt(
      "Base prompt.",
      "",
      session({
        experience: "work",
        workspaceKind: "local_project",
        cwd: repositoryRoot,
      }),
      { toolInstructionMode: "none" },
    );

    expect(developmentPrompt).toContain("Repository-aware Work:");
    expect(developmentPrompt).toContain(
      "If a command or tool fails, inspect the result, correct the approach, and retry when safe.",
    );
    expect(developmentPrompt).toContain(
      "never use broad or ambiguous destructive commands",
    );
    expect(developmentPrompt).toContain(
      "Use ./cli --staging changes --run for staging.",
    );
    expect(chatPrompt).not.toContain("Repository-aware Work:");
    expect(chatPrompt).not.toContain(
      "Use ./cli --staging changes --run for staging.",
    );
    expect(workPrompt).toContain("Repository-aware Work:");
    expect(workPrompt).toContain("Use ./cli --staging changes --run for staging.");
  });
});

async function createTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "openpond-development-context-"),
  );
  temporaryRoots.push(root);
  return root;
}

async function createGitRepository(): Promise<string> {
  const repositoryRoot = await createTemporaryRoot();
  await initializeGitRepository(repositoryRoot);
  return repositoryRoot;
}

async function initializeGitRepository(repositoryRoot: string): Promise<void> {
  const result = await runWorkspaceCommand("git", ["init"], repositoryRoot);
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || "git init failed");
  }
}

function session(
  input: Pick<Session, "experience" | "workspaceKind" | "cwd">,
): Session {
  return {
    id: `session_${input.experience}`,
    experience: input.experience,
    provider: "openpond",
    modelRef: { providerId: "openpond", modelId: "openpond-chat" },
    openPondCommandAccessMode: "full-access",
    title: "Prompt test",
    appId: null,
    appName: null,
    workspaceKind: input.workspaceKind,
    workspaceId: null,
    workspaceName: null,
    localProjectId: null,
    cloudProjectId: null,
    cloudTeamId: null,
    cwd: input.cwd,
    codexThreadId: null,
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z",
    status: "idle",
    pinned: false,
    savedForLater: false,
    archived: false,
    order: 0,
  };
}
