import { describe, expect, test } from "bun:test";

import { appReducer, initialAppState, type AppState } from "../apps/web/src/app/app-state";

describe("app state composer drafts", () => {
  test("keeps main composer drafts scoped to the selected conversation", () => {
    let state: AppState = initialAppState;

    state = appReducer(state, { type: "field", key: "prompt", value: "general draft" });
    state = appReducer(state, { type: "selectSession", sessionId: "session_1" });
    expect(state.prompt).toBe("");

    state = appReducer(state, { type: "field", key: "prompt", value: "session one draft" });
    state = appReducer(state, { type: "selectSession", sessionId: "session_2" });
    expect(state.prompt).toBe("");

    state = appReducer(state, { type: "field", key: "prompt", value: "session two draft" });
    state = appReducer(state, { type: "selectSession", sessionId: "session_1" });
    expect(state.prompt).toBe("session one draft");

    state = appReducer(state, { type: "selectSession", sessionId: "session_2" });
    expect(state.prompt).toBe("session two draft");

    state = appReducer(state, { type: "beginNewChat", appId: null });
    expect(state.prompt).toBe("");

    state = appReducer(state, { type: "selectSession", sessionId: "session_1" });
    expect(state.prompt).toBe("session one draft");
  });

  test("does not carry session drafts into project or app composers", () => {
    let state: AppState = initialAppState;

    state = appReducer(state, { type: "selectSession", sessionId: "session_1" });
    state = appReducer(state, { type: "field", key: "prompt", value: "session draft" });
    state = appReducer(state, { type: "selectProject", projectId: "local:project_1" });
    expect(state.prompt).toBe("");

    state = appReducer(state, { type: "field", key: "prompt", value: "project draft" });
    state = appReducer(state, { type: "selectApp", appId: "app_1" });
    expect(state.prompt).toBe("");

    state = appReducer(state, { type: "field", key: "prompt", value: "app draft" });
    state = appReducer(state, { type: "selectProject", projectId: "local:project_1" });
    expect(state.prompt).toBe("project draft");

    state = appReducer(state, { type: "selectApp", appId: "app_1" });
    expect(state.prompt).toBe("app draft");
  });
});
