import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
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

  test("extracts array and wrapped tool requests", () => {
    const requests = extractWorkspaceToolRequests(
      '<openpond_tool>{"tools":[{"action":"list_files"},{"action":"search_files","args":{"query":"schema"}}]}</openpond_tool>'
    );

    assert.deepEqual(
      requests.map((request) => request.action),
      ["list_files", "search_files"]
    );
  });

  test("extracts valid tool requests from provider json tags", () => {
    const requests = extractWorkspaceToolRequests(
      '<json>\n{"action":"sandbox_read_file","args":{"path":"README.md"}}\n</json>'
    );

    assert.equal(requests.length, 1);
    assert.equal(requests[0].action, "sandbox_read_file");
    assert.deepEqual(requests[0].args, { path: "README.md" });
  });

  test("ignores ordinary JSON that is not a workspace tool request", () => {
    const requests = extractWorkspaceToolRequests('```json\n{"ok":true,"message":"done"}\n```');
    assert.equal(requests.length, 0);
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
        remoteUrl: "https://staging.openpond.ai/example.git",
        workspace: {
          repoPath: "/tmp/openpond/repo",
          workspacePath: "/tmp/openpond",
        },
        files: [{ path: "tools/prompt-agent.ts", status: "M" }],
      },
    });

    assert.match(output, /tools\/prompt-agent\.ts/);
    assert.doesNotMatch(output, /staging\.openpond\.ai/);
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
