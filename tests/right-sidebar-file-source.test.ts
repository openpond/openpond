import { describe, expect, test } from "vitest";
import { resolveRightSidebarFileSource } from "../apps/web/src/lib/right-sidebar-file-source";

describe("resolveRightSidebarFileSource", () => {
  test("defaults Hybrid to sandbox when local and sandbox sources exist", () => {
    const state = resolveRightSidebarFileSource({
      workspaceTarget: "hybrid",
      localWorkspaceId: "local_1",
      sandboxWorkspaceId: "sandbox_1",
      override: null,
    });

    expect(state.source).toBe("sandbox");
    expect(state.options.map((option) => option.value)).toEqual(["local", "sandbox"]);
  });

  test("defaults Local to local while keeping sandbox available for comparison", () => {
    const state = resolveRightSidebarFileSource({
      workspaceTarget: "local",
      localWorkspaceId: "local_1",
      sandboxWorkspaceId: "sandbox_1",
      override: null,
    });

    expect(state.source).toBe("local");
    expect(state.options.map((option) => option.value)).toEqual(["local", "sandbox"]);
  });

  test("honors an available explicit override", () => {
    const state = resolveRightSidebarFileSource({
      workspaceTarget: "hybrid",
      localWorkspaceId: "local_1",
      sandboxWorkspaceId: "sandbox_1",
      override: "local",
    });

    expect(state.source).toBe("local");
  });

  test("keeps pending Hybrid sandbox selected before an id is attached", () => {
    const state = resolveRightSidebarFileSource({
      workspaceTarget: "hybrid",
      localWorkspaceId: "local_1",
      sandboxSourceAvailable: true,
      sandboxWorkspaceId: null,
      override: null,
    });

    expect(state.source).toBe("sandbox");
    expect(state.options.map((option) => option.value)).toEqual(["local", "sandbox"]);
  });
});
