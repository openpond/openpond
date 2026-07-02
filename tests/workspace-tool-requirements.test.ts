import { describe, expect, test } from "bun:test";

import { requiresWorkspaceToolForPrompt } from "../apps/server/src/runtime/workspace-tool-requirements";

describe("workspace tool requirements", () => {
  test("requires tools for explicit sandbox tool prompts", () => {
    expect(
      requiresWorkspaceToolForPrompt(
        { workspaceKind: "sandbox" },
        "Call sandbox_write_file with path OPENPOND_CLOUD_E2E.txt and content TEST.",
      ),
    ).toBe(true);
  });

  test("requires tools for workspace file mutation prompts", () => {
    expect(
      requiresWorkspaceToolForPrompt(
        { workspaceKind: "local_project" },
        "Update package.json to add the missing script.",
      ),
    ).toBe(true);
  });

  test("does not require tools for conceptual file questions", () => {
    expect(
      requiresWorkspaceToolForPrompt(
        { workspaceKind: "sandbox" },
        "How should I edit this file safely?",
      ),
    ).toBe(false);
  });

  test("does not require tools without a workspace-backed session", () => {
    expect(
      requiresWorkspaceToolForPrompt(
        { workspaceKind: undefined },
        "Write OPENPOND_CLOUD_E2E.txt",
      ),
    ).toBe(false);
  });
});
