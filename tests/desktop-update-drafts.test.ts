import { expect, test } from "vitest";
import { createComposerDraftStore } from "../apps/web/src/lib/composer-draft-store";
import { restoreDesktopUpdateDrafts, saveDesktopUpdateDrafts } from "../apps/web/src/lib/desktop-update-drafts";
import { restoreConversationSidebarSnapshot, saveConversationSidebarSnapshot } from "../apps/web/src/lib/conversation-sidebar-storage";
import { defaultWorkspaceDiffPanelViewState } from "../apps/web/src/components/workspace-diff/workspace-diff-panel-model";
import { defaultOpenRightSidebarConversationState, rightSidebarWorkspacePanelStateKey } from "../apps/web/src/lib/right-sidebar-conversation-state";

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
