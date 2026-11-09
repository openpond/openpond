import { expect, test } from "vitest";
import { appReducer, initialAppState, type AppAction } from "../apps/web/src/app/app-state";
import { captureSubmittedDraftClear, createComposerDraftStore } from "../apps/web/src/lib/composer-draft-store";
import { restoreDesktopUpdateDrafts, saveDesktopUpdateDrafts } from "../apps/web/src/lib/desktop-update-drafts";
import { restoreConversationSidebarSnapshot, saveConversationSidebarSnapshot } from "../apps/web/src/lib/conversation-sidebar-storage";
import { defaultWorkspaceDiffPanelViewState } from "../apps/web/src/components/workspace-diff/workspace-diff-panel-model";
import { defaultOpenRightSidebarConversationState, rightSidebarWorkspacePanelStateKey } from "../apps/web/src/lib/right-sidebar-conversation-state";

// An accepted first send must not resurrect in New chat or consume another
// conversation's draft; edits made while the request is pending remain unsent.
test("accepted sends clear their original draft without consuming newer edits", () => {
  const store = createComposerDraftStore();
  store.set("Submitted starter");
  const clear = captureSubmittedDraftClear(store);
  store.applyAppAction({ type: "selectSession", sessionId: "created" });
  store.set("Next reply");
  expect(clear()).toBe(false);
  expect(store.getSnapshot()).toBe("Next reply");
  store.applyAppAction({ type: "beginNewChat", appId: null });
  expect(store.getSnapshot()).toBe("");
  store.set("Another starter");
  const delayedClear = captureSubmittedDraftClear(store);
  store.set("Edited while sending");
  expect(delayedClear()).toBe(false);
  expect(store.getSnapshot()).toBe("Edited while sending");
  expect(captureSubmittedDraftClear(store)()).toBe(true);
  expect(store.getSnapshot()).toBe("");
});

// Inheriting a folder must switch both draft stores atomically, without copying
// an unsent reply or its training resources into the new task.
test("new tasks inherit a project while keeping conversation drafts separate", () => {
  let state = initialAppState;
  const store = createComposerDraftStore();
  const apply = (action: AppAction) => {
    state = appReducer(state, action);
    store.applyAppAction(action);
    expect(store.getSnapshot()).toBe(state.prompt);
  };
  apply({ type: "beginNewChat", appId: null, projectId: "local:repo" });
  apply({ type: "field", key: "prompt", value: "Project task draft" });
  apply({ type: "selectSession", sessionId: "source-chat", projectId: "local:repo" });
  apply({ type: "field", key: "prompt", value: "Unsent reply" });
  store.resourceContexts.set("session:source-chat", [{ scopeId: "training", selectionVersion: 1, resources: [] }]);
  apply({ type: "beginNewChat", appId: null, projectId: "local:repo" });
  expect(state).toMatchObject({ selectedSessionId: null, selectedProjectId: "local:repo", selectedAppId: null });
  expect(store.getScopeKey()).toBe("project:local:repo");
  expect(store.getSnapshot()).toBe("Project task draft");
  expect(store.resourceContexts.has(store.getScopeKey())).toBe(false);
  apply({ type: "beginNewChat", appId: null, projectId: "local:repo" });
  expect(store.getSnapshot()).toBe("Project task draft");
  apply({ type: "beginNewChat", appId: null });
  expect(state.selectedProjectId).toBeNull();
  expect(store.getScopeKey()).toBe("new-chat");
  apply({ type: "selectSession", sessionId: "source-chat", projectId: "local:repo" });
  expect(store.getSnapshot()).toBe("Unsent reply");
  expect(store.resourceContexts.has("session:source-chat")).toBe(true);
});

// Reload creates fresh stores: inactive drafts and exact tabs must survive,
// while a sent draft or intentionally closed Training tab must stay cleared.
test("recovers scoped drafts and tabs without reviving cleared state", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  } as Storage;
  const oldStore = createComposerDraftStore();
  oldStore.set("New task draft");
  const decisionId = `managed-decision:${"a".repeat(64)}`;
  const decisionDraft = { stateJson: '{"unfinished":', questions: [],
    limits: { maximumPromptTokens: "512", maximumForwardTokenWork: "2048", maximumDurationSeconds: "30" } };
  oldStore.setDecisionDraftForScope("new-chat", decisionId, decisionDraft);
  oldStore.setDecisionDraftForScope("session:decision-only", decisionId, decisionDraft);
  oldStore.applyAppAction({ type: "selectSession", sessionId: "chat-1" });
  oldStore.set("Unsent chat reply");
  const contexts = [{scopeId:"experiment-one",selectionVersion:7,resources:[{kind:"dataset" as const,id:"quotes",revision:3}]}];
  oldStore.resourceContexts.set("session:chat-1", contexts);
  oldStore.applyAppAction({type:"selectSession",sessionId:"chat-2"});
  oldStore.set("Another conversation");
  saveDesktopUpdateDrafts(oldStore.getDrafts(), storage);
  const workspaceKey=rightSidebarWorkspacePanelStateKey({conversationId:"chat-1",workspaceSourceKey:"cwd:/demo"});
  const sidebar={conversations:{"chat-1":defaultOpenRightSidebarConversationState()},workspaces:{[workspaceKey]:{
    ...defaultWorkspaceDiffPanelViewState(),activeTab:"outputs" as const,
    overviewTabs:[0,-1],activeOverviewId:-1,tabOrder:["overview-0","overview--1"],
  }}};
  saveConversationSidebarSnapshot(sidebar,storage);
  const restored = restoreDesktopUpdateDrafts(storage);
  expect(restoreDesktopUpdateDrafts(storage)).toEqual(restored);
  const newStore = createComposerDraftStore(undefined, restored);
  expect(restoreDesktopUpdateDrafts(storage)).toEqual(restored);
  expect(newStore.getSnapshot()).toBe("New task draft");
  expect(newStore.getDecisionDraft("new-chat", decisionId)).toEqual(decisionDraft);
  expect(newStore.getDecisionDraft("new-chat", `managed-decision:${"b".repeat(64)}`)).toBeNull();
  expect(newStore.getDecisionDraft("session:decision-only", decisionId)).toEqual(decisionDraft);
  newStore.setDecisionDraftForScope("session:decision-only", decisionId, null);
  expect(newStore.getDecisionDraft("new-chat", decisionId)).toEqual(decisionDraft);
  newStore.applyAppAction({ type: "selectSession", sessionId: "chat-1" });
  expect(newStore.getSnapshot()).toBe("Unsent chat reply");
  expect(newStore.resourceContexts.get("session:chat-1")).toEqual(contexts);
  const reopenedSidebar=restoreConversationSidebarSnapshot(storage);
  expect(reopenedSidebar.workspaces[workspaceKey]?.activeOverviewId).toBe(-1);
  expect(reopenedSidebar.conversations["chat-1"]?.diffPanelOpen).toBe(true);
  expect(reopenedSidebar.conversations["chat-2"]).toBeUndefined();
  newStore.applyAppAction({type:"selectSession",sessionId:"chat-2"});
  expect(newStore.resourceContexts.get("session:chat-2")).toBeUndefined();
  let persistedClear=false;
  const unsubscribe=newStore.subscribe(()=>{saveDesktopUpdateDrafts(newStore.getDrafts(),storage);persistedClear=true;});
  newStore.setForScope("session:chat-1", "");
  unsubscribe();
  expect(persistedClear).toBe(true);
  expect(newStore.resourceContexts.has("session:chat-1")).toBe(false);
  expect(newStore.getSnapshot()).toBe("Another conversation");
  const afterSend=createComposerDraftStore(undefined,restoreDesktopUpdateDrafts(storage));
  afterSend.applyAppAction({type:"selectSession",sessionId:"chat-1"});
  expect(afterSend.getSnapshot()).toBe("");
  expect(afterSend.resourceContexts.has("session:chat-1")).toBe(false);
  reopenedSidebar.workspaces[workspaceKey]={...defaultWorkspaceDiffPanelViewState(),activeTab:"outputs"};
  saveConversationSidebarSnapshot(reopenedSidebar,storage);
  expect(restoreConversationSidebarSnapshot(storage).workspaces[workspaceKey]?.overviewTabs).toEqual([0]);
  saveDesktopUpdateDrafts({},storage);
  expect(restoreDesktopUpdateDrafts(storage)).toEqual({});
});
