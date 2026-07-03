import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  extractProfileSkillReadRequests,
  extractWorkspaceToolRequests,
  formatWorkspaceToolValidationErrorForModel,
  formatWorkspaceToolResultForModel,
  HOSTED_WORKSPACE_TOOL_PROTOCOL,
  validateWorkspaceToolRequest,
} from "../apps/server/dist/openpond/hosted-tool-protocol.js";

describe("hosted workspace tool protocol", () => {
  test("extracts a single fenced workspace tool request", () => {
    const requests = extractWorkspaceToolRequests(
      '```openpond_tool\n{"action":"read_files","args":{"paths":["package.json"]}}\n```'
    );

    assert.equal(requests.length, 1);
    assert.equal(requests[0].action, "read_files");
    assert.deepEqual(requests[0].args, { paths: ["package.json"] });
    assert.equal(requests[0].source, "chat_action");
  });

  test("rejects legacy and generic workspace fallback shapes", () => {
    const examples = [
      '<openpond_tool>{"action":"list_files"}</openpond_tool>',
      '<json>{"action":"sandbox_read_file","args":{"path":"README.md"}}</json>',
      '```openpond-tools\n{"action":"list_files"}\n```',
      '```openpond_tool_call\n{"action":"list_files"}\n```',
      '```json\n{"action":"list_files"}\n```',
      '{"action":"list_files"}',
      '```openpond_tool\n[{"action":"list_files"}]\n```',
      '```openpond_tool\n{"tools":[{"action":"list_files"}]}\n```',
    ];

    for (const example of examples) {
      assert.deepEqual(extractWorkspaceToolRequests(example), []);
    }
  });

  test("extracts profile skill read fallback requests", () => {
    const requests = extractProfileSkillReadRequests(
      '```openpond_skill\n{"name":"release-notes"}\n```'
    );

    assert.equal(requests.length, 1);
    assert.equal(requests[0].name, "release-notes");
  });

  test("rejects legacy and wrapped profile skill fallback shapes", () => {
    const examples = [
      '<openpond_skill>{"name":"release-notes"}</openpond_skill>',
      '```openpond-skill\n{"name":"release-notes"}\n```',
      '```openpond_skill_read\n{"name":"release-notes"}\n```',
      '```profile_skill_read\n{"name":"release-notes"}\n```',
      '```openpond_skill\n[{"name":"release-notes"}]\n```',
      '```openpond_skill\n{"skills":[{"name":"release-notes"}]}\n```',
    ];

    for (const example of examples) {
      assert.deepEqual(extractProfileSkillReadRequests(example), []);
    }
  });

  test("formats tool results for follow-up model turns", () => {
    const output = formatWorkspaceToolResultForModel({
      ok: true,
      action: "workspace_status",
      appId: "app_test",
      output: "Workspace is initialized.",
      data: { initialized: true },
    });

    assert.match(output, /workspace_status/);
    assert.match(output, /Workspace is initialized/);
    assert.match(HOSTED_WORKSPACE_TOOL_PROTOCOL, /openpond_tool/);
    assert.match(HOSTED_WORKSPACE_TOOL_PROTOCOL, /validate_sandbox_template/);
  });

  test("omits internal git and workspace locations from model-facing tool data", () => {
    const output = formatWorkspaceToolResultForModel({
      ok: true,
      action: "git_status",
      output: "Workspace has 1 changed file.",
      data: {
        branch: "master",
        upstream: "origin/master",
        remoteUrl: "https://git.qa.example/example.git",
        workspace: {
          repoPath: "/tmp/openpond/repo",
          workspacePath: "/tmp/openpond",
        },
        files: [{ path: "tools/prompt-agent.ts", status: "M" }],
      },
    });

    assert.match(output, /tools\/prompt-agent\.ts/);
    assert.doesNotMatch(output, /git\.qa\.example/);
    assert.doesNotMatch(output, /repoPath/);
    assert.doesNotMatch(output, /workspacePath/);
  });

  test("validates required args before tool execution", () => {
    const issues = validateWorkspaceToolRequest({ action: "edit_file", args: {} });

    assert.deepEqual(
      issues.map((issue) => issue.path),
      ["args.path", "args.oldText", "args.newText"]
    );

    const output = formatWorkspaceToolValidationErrorForModel({ action: "edit_file", args: {} }, issues);
    assert.match(output, /Invalid edit_file tool request/);
    assert.match(output, /validationError/);
    assert.match(output, /read_files first/);
    assert.match(HOSTED_WORKSPACE_TOOL_PROTOCOL, /replaceAll/);
  });

  test("accepts complete edit and write tool requests", () => {
    assert.deepEqual(
      validateWorkspaceToolRequest({
        action: "edit_file",
        args: {
          path: "tools/prompt-agent.ts",
          oldText: "old profile",
          newText: "",
        },
      }),
      []
    );
    assert.deepEqual(
      validateWorkspaceToolRequest({
        action: "write_files",
        args: {
          files: {
            "tools/prompt-agent.ts": "export const profile = {};\n",
          },
        },
      }),
      []
    );
    assert.deepEqual(
      validateWorkspaceToolRequest({
        action: "validate_sandbox_template",
        args: {},
      }),
      []
    );
  });

  test("accepts sandbox workspace lifecycle, snapshot, and replay tool requests", () => {
    const requests = [
      { action: "sandbox_create", args: { repo: "https://github.com/openpond/example" } },
      { action: "sandbox_templates", args: { teamId: "team_test" } },
      { action: "sandbox_template_launch", args: { templateName: "node-bun-workspace" } },
      { action: "sandbox_snapshot_create", args: { name: "workbench-v1" } },
      { action: "sandbox_snapshot_validate", args: { snapshotId: "snapshot_test" } },
      { action: "sandbox_snapshot_publish", args: { snapshotId: "snapshot_test" } },
      { action: "sandbox_edit_file", args: { path: "README.md", oldText: "old", newText: "new" } },
      { action: "sandbox_delete_file", args: { path: "tmp.txt" } },
      { action: "sandbox_mkdir", args: { path: "src" } },
      { action: "sandbox_move_file", args: { fromPath: "a.txt", toPath: "b.txt" } },
      { action: "sandbox_git_status", args: {} },
      { action: "sandbox_git_diff", args: {} },
      { action: "sandbox_git_export_patch", args: {} },
      { action: "sandbox_git_branch", args: { branch: "feature/test" } },
      { action: "sandbox_git_commit", args: { message: "Update sandbox files" } },
      { action: "sandbox_git_pull", args: {} },
      { action: "sandbox_git_push", args: {} },
      { action: "sandbox_preserve_source", args: {} },
      { action: "sandbox_promote_source", args: {} },
      { action: "sandbox_replay_start", args: { snapshotId: "snapshot_test" } },
      { action: "sandbox_replay_artifacts", args: { replayId: "replay_test" } },
    ];

    for (const request of requests) {
      assert.deepEqual(validateWorkspaceToolRequest(request), []);
      assert.match(HOSTED_WORKSPACE_TOOL_PROTOCOL, new RegExp(request.action));
    }
  });
});
