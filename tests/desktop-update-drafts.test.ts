import { expect, test } from "vitest";
import { createComposerDraftStore } from "../apps/web/src/lib/composer-draft-store";
import { clearDesktopUpdateDrafts, restoreDesktopUpdateDrafts, saveDesktopUpdateDrafts } from "../apps/web/src/lib/desktop-update-drafts";

// Restart creates a fresh renderer/store. Drafts for inactive conversations
// must survive too, and StrictMode's double initialization must not consume them.
test("recovers all scoped drafts once after an update restart", () => {
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
  const restored = restoreDesktopUpdateDrafts(storage);
  expect(restoreDesktopUpdateDrafts(storage)).toEqual(restored);
  const newStore = createComposerDraftStore(undefined, restored);
  clearDesktopUpdateDrafts(storage);
  expect(newStore.getSnapshot()).toBe("New task draft");
  newStore.applyAppAction({ type: "selectSession", sessionId: "chat-1" });
  expect(newStore.getSnapshot()).toBe("Unsent chat reply");
  expect(newStore.resourceContexts.get("session:chat-1")).toEqual(contexts);
  newStore.applyAppAction({type:"selectSession",sessionId:"chat-2"});
  expect(newStore.resourceContexts.get("session:chat-2")).toBeUndefined();
  newStore.setForScope("session:chat-1", "");
  expect(newStore.resourceContexts.has("session:chat-1")).toBe(false);
  expect(newStore.getSnapshot()).toBe("Another conversation");
  expect(restoreDesktopUpdateDrafts(storage)).toEqual({});
});
