import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  applyAgentImprovementCandidateLocally,
  cleanupAgentImprovementWorkspace,
  commitAgentImprovementCandidate,
  openAgentImprovementPullRequest,
  prepareAgentImprovementWorkspace,
} from "../apps/server/src/runtime/create-pipeline/agent-improvement-git";
import { authorAgentImprovementCandidate } from "../apps/server/src/runtime/create-pipeline/agent-improvement";
import { createTasksetRef } from "../apps/server/src/training/create-improve-taskset-lineage";
import { runWorkspaceCommand } from "../apps/server/src/workspace/workspaces";
import type { LocalCreatePipelineTarget } from "../apps/server/src/runtime/local-create-pipeline";
import { createImproveRunFixture } from "./helpers/create-improve-fixtures";
import { proposalFixture, tasksetFixture } from "./helpers/training-fixtures";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

describe("Agent improvement Git candidate", () => {
  test("runs the approved improve path through isolated authoring and matched Eval receipts", async () => {
    const fixture = await profileRepoFixture();
    const taskset = tasksetFixture();
    const tasksetRef = createTasksetRef({
      taskset,
      proposal: proposalFixture(),
      evidenceSnapshotIds: ["evidence_snapshot_fixture"],
      approvedAt: "2026-07-16T12:00:00.000Z",
    });
    const run = createImproveRunFixture({ ...improveRun(fixture), tasksetRef });
    const revisions: string[] = [];
    let authoringContext: unknown = null;
    const result = await authorAgentImprovementCandidate(
      run,
      {
        session: { id: "session_1" } as never,
        turn: { id: "turn_1" } as never,
        ensureCodexRuntime: async () => {
          throw new Error("The injected source author should replace Codex.");
        },
        appendRuntimeEvent: async () => undefined,
        setProviderTurnId: async () => undefined,
        onRun: async (snapshot) => {
          revisions.push(snapshot.state);
        },
        model: "openpond-test",
        resolveTaskset: async () => taskset,
        gradeTaskAttempt: async () => { throw new Error("Injected receipt normalizer handles this fixture."); },
      },
      {
        applySource: async ({ snapshot, target }) => {
          authoringContext = snapshot.metadata.tasksetAuthoringContext;
          await writeFile(
            path.join(target.sourceRoot, "agent", "agent.ts"),
            "export const behavior = 'candidate';\n",
            "utf8",
          );
        },
        runChecks: async () => ({
          checkRefs: ["profiles/default/agents/support/.openpond/agent-inspect.json"],
          metadata: { inspect: { summary: "passed" } },
        }),
        evaluate: async (input) => ({
          id: `eval_${input.subject}`,
          candidateId: input.candidateId,
          target: input.run.target,
          evaluatorKind: "agent_sdk",
          subject: input.subject,
          sourceCommit: input.sourceCommit,
          sourceBranch: input.sourceBranch,
          tasksetId: taskset.id,
          tasksetHash: taskset.contentHash,
          taskAttemptRefs: [`attempt_${input.subject}`],
          status: input.subject === "active" ? "failed" : "passed",
          publishGate: input.subject === "active" ? "failed" : "passed",
          summaryCounts: input.subject === "active"
            ? { total: 1, passed: 0, failed: 1 }
            : { total: 1, passed: 1, failed: 0 },
          evalRefs: ["corrected behavior"],
          artifactRefs: [],
          summary: input.subject,
          createdAt: "2026-07-16T12:00:00.000Z",
          metadata: {
            trustedTasksetExecution: true,
            executionContractHash: "matched_contract_hash",
          },
        }),
      },
    );

    expect(result.state).toBe("awaiting_promotion");
    expect(result.localProfileCommit).toBeNull();
    expect(revisions).toEqual(["applying_source", "running_checks", "evaluating"]);
    expect(result.candidates[0]).toMatchObject({
      status: "evaluated",
      git: {
        baseCommit: fixture.head,
        changedPaths: ["profiles/default/agents/support/agent/agent.ts"],
      },
    });
    expect(result.evaluationReceipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ subject: "active", status: "failed" }),
      expect.objectContaining({ subject: "candidate", status: "passed" }),
    ]));
    expect(result.externalExecutionRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "candidate_authoring",
        status: "completed",
        metadata: expect.objectContaining({ candidateId: result.candidates[0]?.id }),
      }),
      expect.objectContaining({
        kind: "evaluation",
        status: "completed",
        metadata: expect.objectContaining({
          candidateId: result.candidates[0]?.id,
          tasksetHash: taskset.contentHash,
          executionContractHash: "matched_contract_hash",
        }),
      }),
    ]));
    expect(authoringContext).toMatchObject({
      tasksetId: taskset.id,
      tasksetRevision: taskset.revision,
      tasks: [{ id: "task_train", input: { prompt: "Say hello" } }],
      privateEvaluation: { caseCount: 1, contentsWithheld: true },
    });
    expect(JSON.stringify(authoringContext)).not.toContain("task_eval");
    expect(JSON.stringify(authoringContext)).not.toContain("Say goodbye");
    await expect(readFile(fixture.agentSource, "utf8")).resolves.toBe(
      "export const behavior = 'active';\n",
    );

    await cleanupAgentImprovementWorkspace({
      repoPath: fixture.repoPath,
      git: result.candidates[0]!.git!,
    });
  });

  test("authors and commits an isolated candidate without changing the active Profile checkout", async () => {
    const fixture = await profileRepoFixture();
    const run = createImproveRunFixture({
      operation: "improve",
      state: "applying_source",
      target: {
        kind: "agent",
        id: "support",
        displayName: "Support",
        defaultActionKey: "support.chat",
      },
      adapter: {
        kind: "local",
        sourceAuthority: "local_profile",
        activeProfile: "default",
        repoPath: fixture.repoPath,
        sourcePath: fixture.sourcePath,
        localHead: fixture.head,
        confirmationPolicy: "always_require_plan_approval",
      },
      plan: {
        ...createImproveRunFixture({ state: "applying_source" }).plan!,
        status: "approved",
        sourcePlan: [{
          path: "agents/support",
          operation: "update",
          reason: "Improve Support behavior.",
        }],
      },
    });
    const target = localTarget(fixture);
    const workspace = await prepareAgentImprovementWorkspace({ run, target });
    const candidateSource = path.join(workspace.target.sourceRoot, "agent", "agent.ts");
    await writeFile(candidateSource, "export const behavior = 'candidate';\n", "utf8");

    const git = await commitAgentImprovementCandidate({
      run,
      activeTarget: target,
      workspace,
    });

    expect(git.baseCommit).toBe(fixture.head);
    expect(git.headCommit).not.toBe(fixture.head);
    expect(git.changedPaths).toEqual([
      "profiles/default/agents/support/agent/agent.ts",
    ]);
    await expect(readFile(fixture.agentSource, "utf8")).resolves.toBe(
      "export const behavior = 'active';\n",
    );
    await expect(readFile(candidateSource, "utf8")).resolves.toBe(
      "export const behavior = 'candidate';\n",
    );

    await cleanupAgentImprovementWorkspace({
      repoPath: fixture.repoPath,
      git,
    });
  });

  test("snapshots dirty Profile source into the candidate baseline without requiring a remote", async () => {
    const fixture = await profileRepoFixture();
    await git(fixture.repoPath, ["remote", "remove", "origin"]);
    await writeFile(fixture.agentSource, "export const behavior = 'working tree';\n", "utf8");
    const skillPath = path.join(fixture.sourcePath, "skills", "search", "SKILL.md");
    const privateTasksetPath = path.join(fixture.sourcePath, "tasksets", "private", "fixtures.json");
    await mkdir(path.dirname(skillPath), { recursive: true });
    await mkdir(path.dirname(privateTasksetPath), { recursive: true });
    await writeFile(skillPath, "# Search\n", "utf8");
    await writeFile(privateTasksetPath, "private fixture\n", "utf8");
    const run = improveRun(fixture);
    const target = localTarget(fixture);

    const workspace = await prepareAgentImprovementWorkspace({ run, target });

    expect(workspace.git.remoteUrl).toBeNull();
    expect(workspace.git.baseCommit).not.toBe(fixture.head);
    await expect(readFile(
      path.join(workspace.target.sourceRoot, "agent", "agent.ts"),
      "utf8",
    )).resolves.toBe("export const behavior = 'working tree';\n");
    await expect(readFile(
      path.join(workspace.target.sourcePath, "skills", "search", "SKILL.md"),
      "utf8",
    )).resolves.toBe("# Search\n");
    await expect(readFile(
      path.join(workspace.target.sourcePath, "tasksets", "private", "fixtures.json"),
      "utf8",
    )).rejects.toThrow();
    const activeStatus = await git(fixture.repoPath, ["status", "--short"]);
    expect(activeStatus.stdout).toContain("agent/agent.ts");
    expect(activeStatus.stdout).toContain("profiles/default/skills/");

    await cleanupAgentImprovementWorkspace({
      repoPath: fixture.repoPath,
      git: workspace.git,
    });
  });

  test("merges the reviewed candidate into the dirty local Profile without requiring GitHub", async () => {
    const fixture = await profileRepoFixture();
    await git(fixture.repoPath, ["remote", "remove", "origin"]);
    await writeFile(fixture.agentSource, "export const behavior = 'working tree';\n", "utf8");
    const skillPath = path.join(fixture.sourcePath, "skills", "search", "SKILL.md");
    await mkdir(path.dirname(skillPath), { recursive: true });
    await writeFile(skillPath, "# Search\n", "utf8");
    const run = improveRun(fixture);
    const target = localTarget(fixture);
    const workspace = await prepareAgentImprovementWorkspace({ run, target });
    await writeFile(
      path.join(workspace.target.sourceRoot, "agent", "agent.ts"),
      "export const behavior = 'candidate';\n",
      "utf8",
    );
    const candidate = await commitAgentImprovementCandidate({
      run,
      activeTarget: target,
      workspace,
    });

    const profileCommit = await applyAgentImprovementCandidateLocally({
      run,
      repoPath: fixture.repoPath,
      git: candidate,
    });

    expect(profileCommit).not.toBe(fixture.head);
    await expect(readFile(fixture.agentSource, "utf8")).resolves.toBe(
      "export const behavior = 'candidate';\n",
    );
    await expect(readFile(skillPath, "utf8")).resolves.toBe("# Search\n");
    expect((await git(fixture.repoPath, ["status", "--short"])).stdout.trim()).toBe("");
    expect((await git(fixture.repoPath, [
      "diff",
      "--quiet",
      profileCommit,
      candidate.headCommit!,
      "--",
      "profiles/default/agents/support/agent/agent.ts",
      "profiles/default/skills/search/SKILL.md",
    ])).code).toBe(0);

    await cleanupAgentImprovementWorkspace({
      repoPath: fixture.repoPath,
      git: candidate,
    });
  });

  test("refuses to merge when the active Profile changed after candidate authoring", async () => {
    const fixture = await profileRepoFixture();
    const run = improveRun(fixture);
    const target = localTarget(fixture);
    const workspace = await prepareAgentImprovementWorkspace({ run, target });
    await writeFile(
      path.join(workspace.target.sourceRoot, "agent", "agent.ts"),
      "export const behavior = 'candidate';\n",
      "utf8",
    );
    const candidate = await commitAgentImprovementCandidate({
      run,
      activeTarget: target,
      workspace,
    });
    await writeFile(fixture.agentSource, "export const behavior = 'newer local edit';\n", "utf8");

    await expect(applyAgentImprovementCandidateLocally({
      run,
      repoPath: fixture.repoPath,
      git: candidate,
    })).rejects.toThrow("changed after this candidate was created");
    await expect(readFile(fixture.agentSource, "utf8")).resolves.toBe(
      "export const behavior = 'newer local edit';\n",
    );

    await cleanupAgentImprovementWorkspace({
      repoPath: fixture.repoPath,
      git: candidate,
    });
  });

  test("blocks changes outside the approved Agent paths", async () => {
    const fixture = await profileRepoFixture();
    const run = improveRun(fixture);
    const target = localTarget(fixture);
    const workspace = await prepareAgentImprovementWorkspace({ run, target });
    await writeFile(path.join(workspace.target.repoPath, "README.md"), "outside\n", "utf8");

    await expect(commitAgentImprovementCandidate({
      run,
      activeTarget: target,
      workspace,
    })).rejects.toThrow("outside the approved scope");

    await cleanupAgentImprovementWorkspace({
      repoPath: fixture.repoPath,
      git: workspace.git,
    });
  });

  test("pushes one candidate branch and normalizes the created GitHub PR", async () => {
    const fixture = await profileRepoFixture();
    const run = improveRun(fixture);
    const target = localTarget(fixture);
    const workspace = await prepareAgentImprovementWorkspace({ run, target });
    await writeFile(
      path.join(workspace.target.sourceRoot, "agent", "agent.ts"),
      "export const behavior = 'candidate';\n",
      "utf8",
    );
    const git = await commitAgentImprovementCandidate({
      run,
      activeTarget: target,
      workspace,
    });
    const calls: string[][] = [];
    const command = async (
      commandName: string,
      args: string[],
      cwd: string,
      env?: NodeJS.ProcessEnv,
    ) => {
      calls.push([commandName, ...args]);
      if (commandName === "git" && args[0] === "push") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (commandName === "gh" && args[1] === "list") {
        return { code: 0, stdout: "[]", stderr: "" };
      }
      if (commandName === "gh" && args[1] === "create") {
        return {
          code: 0,
          stdout: "https://github.com/openpond/profile/pull/42\n",
          stderr: "",
        };
      }
      if (commandName === "gh" && args[1] === "view") {
        return {
          code: 0,
          stdout: JSON.stringify({
            number: 42,
            url: "https://github.com/openpond/profile/pull/42",
            state: "OPEN",
            mergedAt: null,
            mergeCommit: null,
            baseRefName: "main",
            headRefName: git.branch,
          }),
          stderr: "",
        };
      }
      return runWorkspaceCommand(commandName, args, cwd, env);
    };

    const pullRequest = await openAgentImprovementPullRequest({
      run,
      git,
      evaluationSummary: "- Base: failed\n- Candidate: passed",
      command,
      timestamp: "2026-07-16T12:00:00.000Z",
    });

    expect(pullRequest).toMatchObject({
      number: 42,
      state: "open",
      baseBranch: "main",
      headBranch: git.branch,
    });
    expect(calls.filter((call) => call[0] === "git" && call[1] === "push")).toHaveLength(1);
    expect(calls.filter((call) => call[0] === "gh" && call[2] === "create")).toHaveLength(1);

    await cleanupAgentImprovementWorkspace({
      repoPath: fixture.repoPath,
      git,
    });
  });
});

async function profileRepoFixture() {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), "openpond-agent-improvement-"));
  directories.push(repoPath);
  const sourcePath = path.join(repoPath, "profiles", "default");
  const sourceRoot = path.join(sourcePath, "agents", "support");
  const agentSource = path.join(sourceRoot, "agent", "agent.ts");
  await mkdir(path.dirname(agentSource), { recursive: true });
  await mkdir(path.join(sourcePath, "settings"), { recursive: true });
  await writeFile(agentSource, "export const behavior = 'active';\n", "utf8");
  await writeFile(
    path.join(repoPath, "openpond-profile.json"),
    `${JSON.stringify({
      defaultProfile: "default",
      profiles: {
        default: {
          path: "profiles/default",
          enabledAgents: ["support"],
          defaultAgent: "support",
        },
      },
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(sourcePath, "settings", "profile.yaml"),
    "schema: openpond.profile.v1\nprofile: default\nagents:\n  - id: support\n    path: agents/support\n",
    "utf8",
  );
  await git(repoPath, ["init", "-b", "main"]);
  await git(repoPath, ["config", "user.email", "test@example.local"]);
  await git(repoPath, ["config", "user.name", "Test User"]);
  await git(repoPath, ["add", "-A"]);
  await git(repoPath, ["commit", "-m", "Initial profile"]);
  await git(repoPath, ["remote", "add", "origin", "git@github.com:openpond/profile.git"]);
  const head = (await git(repoPath, ["rev-parse", "HEAD"])).stdout.trim();
  return { repoPath, sourcePath, sourceRoot, agentSource, head };
}

function improveRun(fixture: Awaited<ReturnType<typeof profileRepoFixture>>) {
  return createImproveRunFixture({
    operation: "improve",
    state: "applying_source",
    target: {
      kind: "agent",
      id: "support",
      displayName: "Support",
      defaultActionKey: "support.chat",
    },
    adapter: {
      kind: "local",
      sourceAuthority: "local_profile",
      activeProfile: "default",
      repoPath: fixture.repoPath,
      sourcePath: fixture.sourcePath,
      localHead: fixture.head,
      confirmationPolicy: "always_require_plan_approval",
    },
    plan: {
      ...createImproveRunFixture({ state: "applying_source" }).plan!,
      status: "approved",
      sourcePlan: [{
        path: "agents/support",
        operation: "update",
        reason: "Improve Support behavior.",
      }],
    },
  });
}

function localTarget(
  fixture: Awaited<ReturnType<typeof profileRepoFixture>>,
): LocalCreatePipelineTarget {
  return {
    activeProfile: "default",
    agentId: "support",
    defaultAction: "support.chat",
    repoPath: fixture.repoPath,
    sourcePath: fixture.sourcePath,
    workspaceRoot: fixture.repoPath,
    profileRelativePath: "profiles/default",
    sourceRoot: fixture.sourceRoot,
    sourceRootRelativePath: "profiles/default/agents/support",
  };
}

async function git(cwd: string, args: string[]) {
  const result = await runWorkspaceCommand("git", args, cwd, {
    GIT_AUTHOR_NAME: "Test User",
    GIT_AUTHOR_EMAIL: "test@example.local",
    GIT_COMMITTER_NAME: "Test User",
    GIT_COMMITTER_EMAIL: "test@example.local",
  });
  if (result.code !== 0) throw new Error(result.stderr || result.stdout);
  return result;
}
