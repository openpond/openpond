import { useRef, useState } from "react";
import type { Dispatch, DragEvent, SetStateAction } from "react";
import type { Session, SidebarAppPreferences } from "@openpond/contracts";
import { api, type ClientConnection } from "../api";
import {
  getSidebarDropPosition,
  reorderIds,
  sameIds,
  sidebarDragKey,
  type PinnedSidebarItem,
  type SidebarDragItem,
} from "../lib/app-models";

type UsePinnedSidebarDragInput = {
  connection: ClientConnection | null;
  appPreferences: SidebarAppPreferences;
  sessions: Session[];
  pinnedItems: PinnedSidebarItem[];
  setAppPreferences: Dispatch<SetStateAction<SidebarAppPreferences>>;
  setCodexHistorySessions: Dispatch<SetStateAction<Session[]>>;
  setSessions: Dispatch<SetStateAction<Session[]>>;
  setError: (message: string | null) => void;
};

function setSidebarDragImage(event: DragEvent<HTMLDivElement>) {
  const source = event.currentTarget;
  const rect = source.getBoundingClientRect();
  const preview = source.cloneNode(true) as HTMLElement;
  preview.classList.add("sidebar-drag-preview");
  preview.style.width = `${rect.width}px`;
  preview.style.height = `${rect.height}px`;
  preview.style.position = "fixed";
  preview.style.top = "-1000px";
  preview.style.left = "-1000px";
  preview.style.pointerEvents = "none";
  preview.style.boxSizing = "border-box";
  preview.style.maxWidth = "none";
  document.body.appendChild(preview);
  event.dataTransfer.setDragImage(preview, event.clientX - rect.left, event.clientY - rect.top);
  window.setTimeout(() => preview.remove(), 0);
}

export function usePinnedSidebarDrag({
  connection,
  appPreferences,
  sessions,
  pinnedItems,
  setAppPreferences,
  setCodexHistorySessions,
  setSessions,
  setError,
}: UsePinnedSidebarDragInput) {
  const [dragItem, setDragItem] = useState<SidebarDragItem | null>(null);
  const [pinnedPreviewKeys, setPinnedPreviewKeys] = useState<string[] | null>(null);
  const dragItemRef = useRef<SidebarDragItem | null>(null);
  const pinnedPreviewKeysRef = useRef<string[] | null>(null);

  function startPinnedDrag(event: DragEvent<HTMLDivElement>, item: SidebarDragItem) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", `${item.type}:${item.id}`);
    setSidebarDragImage(event);
    const previewKeys = pinnedItems.map((row) => row.key);
    dragItemRef.current = item;
    pinnedPreviewKeysRef.current = previewKeys;
    setDragItem(item);
    setPinnedPreviewKeys(previewKeys);
  }

  function clearSidebarDrag() {
    dragItemRef.current = null;
    pinnedPreviewKeysRef.current = null;
    setDragItem(null);
    setPinnedPreviewKeys(null);
  }

  function previewPinnedDrop(event: DragEvent<HTMLDivElement>, target: SidebarDragItem) {
    const activeDragItem = dragItemRef.current;
    if (!activeDragItem) return;
    const position = getSidebarDropPosition(event);
    const baseKeys = pinnedPreviewKeysRef.current ?? pinnedItems.map((item) => item.key);
    const nextKeys = reorderIds(baseKeys, sidebarDragKey(activeDragItem), sidebarDragKey(target), position);
    if (sameIds(baseKeys, nextKeys)) return;
    pinnedPreviewKeysRef.current = nextKeys;
    setPinnedPreviewKeys(nextKeys);
  }

  function persistPinnedOrder(orderedKeys: string[]) {
    if (!connection) return;
    const currentKeys = pinnedItems.map((item) => item.key);
    const currentKeySet = new Set(currentKeys);
    const nextKeys = [
      ...orderedKeys.filter((key) => currentKeySet.has(key)),
      ...currentKeys.filter((key) => !orderedKeys.includes(key)),
    ];
    if (sameIds(currentKeys, nextKeys)) return;

    const nowIso = new Date().toISOString();
    const previousPreferences = appPreferences;
    const previousSessionById = new Map(sessions.map((session) => [session.id, session]));
    const itemByKey = new Map(pinnedItems.map((item) => [item.key, item]));

    setAppPreferences((current) => {
      const next = { ...current };
      nextKeys.forEach((key, order) => {
        const item = itemByKey.get(key);
        if (item?.type !== "project") return;
        next[item.id] = {
          ...(next[item.id] ?? {}),
          pinned: true,
          archived: false,
          order,
        };
      });
      return next;
    });

    const applySessionOrder = (current: Session[]) => {
      const currentById = new Map(current.map((session) => [session.id, session]));
      const nextSessions = nextKeys
        .map((key, order) => {
          const item = itemByKey.get(key);
          const session = item?.type === "session" ? currentById.get(item.id) : null;
          return session ? { ...session, order, updatedAt: nowIso } : null;
        })
        .filter((session): session is Session => Boolean(session));
      const nextSessionById = new Map(nextSessions.map((session) => [session.id, session]));
      return current.map((session) => nextSessionById.get(session.id) ?? session);
    };
    setSessions(applySessionOrder);
    setCodexHistorySessions(applySessionOrder);

    void Promise.all(
      nextKeys.flatMap((key, order) => {
        const item = itemByKey.get(key);
        if (!item) return [];
        if (item.type === "project") {
          return [api.patchSidebarAppPreference(connection, item.id, { pinned: true, archived: false, order })];
        }
        return [api.patchSession(connection, item.id, { order })];
      })
    ).catch((reorderError) => {
      setError(reorderError instanceof Error ? reorderError.message : String(reorderError));
      setAppPreferences(previousPreferences);
      const rollbackSessionOrder = (current: Session[]) =>
        current.map((session) => previousSessionById.get(session.id) ?? session);
      setSessions(rollbackSessionOrder);
      setCodexHistorySessions(rollbackSessionOrder);
    });
  }

  function commitPinnedDrop(event: DragEvent<HTMLDivElement>, target: SidebarDragItem) {
    const activeDragItem = dragItemRef.current;
    if (activeDragItem) {
      const baseKeys = pinnedPreviewKeysRef.current ?? pinnedItems.map((item) => item.key);
      const nextKeys = reorderIds(baseKeys, sidebarDragKey(activeDragItem), sidebarDragKey(target), getSidebarDropPosition(event));
      persistPinnedOrder(nextKeys);
    }
    clearSidebarDrag();
  }

  function commitPinnedPreviewDrop() {
    const activeDragItem = dragItemRef.current;
    if (activeDragItem) {
      persistPinnedOrder(pinnedPreviewKeysRef.current ?? pinnedItems.map((item) => item.key));
    }
    clearSidebarDrag();
  }

  return {
    dragItem,
    pinnedPreviewKeys,
    startPinnedDrag,
    clearSidebarDrag,
    previewPinnedDrop,
    commitPinnedDrop,
    commitPinnedPreviewDrop,
  };
}
