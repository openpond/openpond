import { describe, expect, test } from "bun:test";
import { createComposerDraftStore } from "../apps/web/src/lib/composer-draft-store";

describe("composer draft store", () => {
  test("keeps drafts scoped while selection actions occur in one synchronous batch", () => {
    const store = createComposerDraftStore();
    store.set("new chat draft");

    store.applyAppAction({ type: "field", key: "selectedSessionId", value: "session_1" });
    store.applyAppAction({ type: "field", key: "selectedProjectId", value: "local:project_1" });
    store.applyAppAction({ type: "field", key: "selectedAppId", value: null });
    expect(store.getSnapshot()).toBe("");

    store.set("project session draft");
    store.applyAppAction({ type: "selectSession", sessionId: null });
    expect(store.getSnapshot()).toBe("new chat draft");

    store.applyAppAction({
      type: "selectSession",
      sessionId: "session_1",
      projectId: "local:project_1",
    });
    expect(store.getSnapshot()).toBe("project session draft");
  });

  test("clears only the selected new-chat draft", () => {
    const store = createComposerDraftStore();
    store.applyAppAction({ type: "selectSession", sessionId: "session_1" });
    store.set("session draft");
    store.applyAppAction({ type: "beginNewChat", appId: null });
    store.set("discard me");

    store.applyAppAction({ type: "beginNewChat", appId: null });
    expect(store.getSnapshot()).toBe("");
    store.applyAppAction({ type: "selectSession", sessionId: "session_1" });
    expect(store.getSnapshot()).toBe("session draft");
  });

  test("publishes only real text or selection changes", () => {
    const store = createComposerDraftStore();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });

    store.set("hello");
    store.set("hello");
    store.set((current) => `${current} world`);
    store.applyAppAction({ type: "selectSession", sessionId: "session_1" });
    unsubscribe();
    store.set("ignored notification");

    expect(notifications).toBe(3);
  });
});
