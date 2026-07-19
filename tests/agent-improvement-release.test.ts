import { describe, expect, test } from "vitest";

import type { CreateImproveEvaluationReceipt, CreateImproveRun } from "@openpond/contracts";

import {
  executeAgentImprovementReleaseAction,
} from "../apps/server/src/runtime/create-pipeline/agent-improvement-release";
import { applyCreateImproveRunAction } from "../apps/server/src/runtime/create-pipeline/snapshots";
import { createImproveRunFixture } from "./helpers/create-improve-fixtures";

describe("Agent improvement PR release", () => {
  test("moves a passing candidate directly into the local merge state", () => {
    const prepared = candidateRun("agent_candidate_fixture");
    const applying = applyCreateImproveRunAction(prepared, {
      type: "apply_candidate",
      runId: prepared.id,
      expectedRevision: prepared.revision,
      actionId: "apply_candidate",
      candidateId: "agent_candidate_fixture",
    });

    expect(applying).toMatchObject({
      state: "reconciling_release",
      releaseOutcome: { status: "pending" },
      metadata: {
        releaseAction: {
          type: "apply_candidate",
          candidateId: "agent_candidate_fixture",
        },
      },
    });
  });

  test("opens one PR, reconciles its merge, syncs the Profile, and requires post-merge Eval success", async () => {
    const candidateId = "agent_candidate_fixture";
    const prepared = candidateRun(candidateId);
    const openAction = {
      type: "open_pull_request" as const,
      runId: prepared.id,
      expectedRevision: prepared.revision,
      actionId: "open_pr",
      candidateId,
    };
    const opening = applyCreateImproveRunAction(prepared, openAction);
    const commands: string[][] = [];
    const command = async (name: string, args: string[]) => {
      commands.push([name, ...args]);
      if (name === "gh" && args[1] === "list") {
        return { code: 0, stdout: "[]", stderr: "" };
      }
      if (name === "gh" && args[1] === "create") {
        return {
          code: 0,
          stdout: "https://github.com/openpond/profile/pull/42\n",
          stderr: "",
        };
      }
      if (name === "gh" && args[1] === "view") {
        return {
          code: 0,
          stdout: JSON.stringify({
            number: 42,
            url: "https://github.com/openpond/profile/pull/42",
            state: "OPEN",
            mergedAt: null,
            mergeCommit: null,
            baseRefName: "main",
            headRefName: "openpond/improve/fixture",
          }),
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const opened = await executeAgentImprovementReleaseAction({
      run: opening,
      action: openAction,
      command,
    });

    expect(opened).toMatchObject({
      state: "pull_request_open",
      releaseOutcome: {
        status: "pending",
        pullRequest: {
          number: 42,
          state: "open",
        },
      },
    });
    expect(opened.externalExecutionRefs).toContainEqual(expect.objectContaining({
      kind: "pull_request",
      id: "42",
      status: "open",
    }));

    const reconcileAction = {
      type: "reconcile_pull_request" as const,
      runId: opened.id,
      expectedRevision: opened.revision,
      actionId: "reconcile_pr",
      candidateId,
    };
    const reconciling = applyCreateImproveRunAction(opened, reconcileAction);
    const mergedCommand = async (name: string, args: string[]) => {
      commands.push([name, ...args]);
      if (name === "gh" && args[1] === "view") {
        return {
          code: 0,
          stdout: JSON.stringify({
            number: 42,
            url: "https://github.com/openpond/profile/pull/42",
            state: "MERGED",
            mergedAt: "2026-07-16T12:30:00.000Z",
            mergeCommit: { oid: "c".repeat(40) },
            baseRefName: "main",
            headRefName: "openpond/improve/fixture",
          }),
          stderr: "",
        };
      }
      if (name === "git" && args[0] === "branch" && args[1] === "--show-current") {
        return { code: 0, stdout: "main\n", stderr: "" };
      }
      if (name === "git" && args[0] === "rev-parse") {
        return { code: 0, stdout: `${"c".repeat(40)}\n`, stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const released = await executeAgentImprovementReleaseAction({
      run: reconciling,
      action: reconcileAction,
      command: mergedCommand,
      evaluate: async (input) => postReleaseReceipt(input.run, candidateId),
    });

    expect(released).toMatchObject({
      state: "released",
      localProfileCommit: "c".repeat(40),
      releaseOutcome: {
        status: "released",
        profileCommit: "c".repeat(40),
        pullRequest: {
          number: 42,
          state: "merged",
        },
      },
    });
    expect(released.candidates[0]).toMatchObject({
      status: "accepted",
      git: { worktreePath: null },
    });
    expect(released.evaluationReceipts).toContainEqual(expect.objectContaining({
      subject: "post_release",
      status: "passed",
    }));
    expect(released.evidenceSnapshots).toContainEqual(expect.objectContaining({
      reviewerIntent: "The promoted Agent passed trusted post-release Taskset evaluation.",
      metadata: expect.objectContaining({
        evidenceKind: "candidate_outcome",
        outcome: "released",
        recommendedNextTasksetRevision: 1,
      }),
    }));
  });
});

function candidateRun(candidateId: string): CreateImproveRun {
  return createImproveRunFixture({
    operation: "improve",
    state: "awaiting_promotion",
    adapter: {
      kind: "local",
      sourceAuthority: "local_profile",
      activeProfile: "default",
      repoPath: "/profiles/default-repo",
      sourcePath: "/profiles/default-repo/profiles/default",
      localHead: "a".repeat(40),
      confirmationPolicy: "always_require_plan_approval",
    },
    candidates: [{
      id: candidateId,
      target: {
        kind: "agent",
        id: "fixture-agent",
        displayName: "Fixture Agent",
        defaultActionKey: "fixture-agent.chat",
      },
      status: "evaluated",
      git: {
        baseBranch: "main",
        baseCommit: "a".repeat(40),
        branch: "openpond/improve/fixture",
        headCommit: "b".repeat(40),
        remoteName: "origin",
        remoteUrl: "git@github.com:openpond/profile.git",
        worktreePath: "/tmp/openpond-agent-candidate/repo",
        changedPaths: ["profiles/default/agents/fixture-agent/agent/agent.ts"],
        diffStat: "1 file changed",
        pullRequest: null,
      },
      sourceRefs: [],
      artifactRefs: [],
      checkRefs: [],
      evaluationReceiptRefs: ["candidate_eval"],
      createdAt: "2026-07-01T10:00:00.000Z",
      updatedAt: "2026-07-01T10:00:00.000Z",
      metadata: {},
    }],
    evaluationReceipts: [{
      id: "candidate_eval",
      candidateId,
      target: {
        kind: "agent",
        id: "fixture-agent",
        displayName: "Fixture Agent",
        defaultActionKey: "fixture-agent.chat",
      },
      evaluatorKind: "agent_sdk",
      subject: "candidate",
      sourceCommit: "b".repeat(40),
      sourceBranch: "openpond/improve/fixture",
      status: "passed",
      publishGate: "passed",
      summaryCounts: { total: 1, passed: 1, failed: 0 },
      evalRefs: ["fixture"],
      artifactRefs: [],
      summary: "1/1 passed",
      createdAt: "2026-07-01T10:00:00.000Z",
      metadata: {},
    }],
  });
}

function postReleaseReceipt(
  run: CreateImproveRun,
  candidateId: string,
): CreateImproveEvaluationReceipt {
  return {
    id: "post_release_eval",
    candidateId,
    target: run.target,
    evaluatorKind: "agent_sdk",
    subject: "post_release",
    sourceCommit: "c".repeat(40),
    sourceBranch: "main",
    status: "passed",
    publishGate: "passed",
    summaryCounts: { total: 1, passed: 1, failed: 0 },
    evalRefs: ["fixture"],
    artifactRefs: [],
    summary: "1/1 passed",
    createdAt: "2026-07-16T12:31:00.000Z",
    metadata: {},
  };
}
