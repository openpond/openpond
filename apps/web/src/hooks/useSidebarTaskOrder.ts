import { useRef, useState } from "react";
import type { Dispatch, DragEvent, SetStateAction } from "react";
import type { Session } from "@openpond/contracts";
import { api, type ClientConnection } from "../api";
import { getSidebarDropPosition, reorderIds } from "../lib/app-models";
import { setSidebarDragImage } from "../lib/sidebar-drag";
import { mergeSidebarTaskOrder } from "../lib/sidebar-task-list";

type TaskDragContext = {
  allSessionIds: string[];
  visibleSessionIds: string[];
  sessionId: string;
};

export function useSidebarTaskOrder({
  connection,
  sessions,
  setCodexHistorySessions,
  setError,
  setSessions,
}: {
  connection: ClientConnection | null;
  sessions: Session[];
  setCodexHistorySessions: Dispatch<SetStateAction<Session[]>>;
  setError: (message: string | null) => void;
  setSessions: Dispatch<SetStateAction<Session[]>>;
}) {
  const [taskDragSessionId, setTaskDragSessionId] = useState<string | null>(
    null
  );
  const [taskPreviewSessionIds, setTaskPreviewSessionIds] = useState<
    string[] | null
  >(null);
  const dragContextRef = useRef<TaskDragContext | null>(null);
  const previewSessionIdsRef = useRef<string[] | null>(null);

  function startTaskDrag(
    event: DragEvent<HTMLDivElement>,
    input: TaskDragContext
  ) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", `session:${input.sessionId}`);
    setSidebarDragImage(event);
    dragContextRef.current = input;
    previewSessionIdsRef.current = input.visibleSessionIds;
    setTaskDragSessionId(input.sessionId);
    setTaskPreviewSessionIds(input.visibleSessionIds);
  }

  function previewTaskDrop(
    event: DragEvent<HTMLDivElement>,
    targetSessionId: string
  ) {
    const context = dragContextRef.current;
    if (!context) return;
    const current = previewSessionIdsRef.current ?? context.visibleSessionIds;
    const next = reorderIds(
      current,
      context.sessionId,
      targetSessionId,
      getSidebarDropPosition(event)
    );
    if (sameStringArray(current, next)) return;
    previewSessionIdsRef.current = next;
    setTaskPreviewSessionIds(next);
  }

  function clearTaskDrag() {
    dragContextRef.current = null;
    previewSessionIdsRef.current = null;
    setTaskDragSessionId(null);
    setTaskPreviewSessionIds(null);
  }

  function commitTaskDrop(
    event: DragEvent<HTMLDivElement>,
    targetSessionId: string
  ) {
    const context = dragContextRef.current;
    if (!context) {
      clearTaskDrag();
      return;
    }
    const current = previewSessionIdsRef.current ?? context.visibleSessionIds;
    const next = reorderIds(
      current,
      context.sessionId,
      targetSessionId,
      getSidebarDropPosition(event)
    );
    persistTaskOrder(
      mergeSidebarTaskOrder(
        context.allSessionIds,
        context.visibleSessionIds,
        next
      )
    );
    clearTaskDrag();
  }

  function commitTaskPreviewDrop() {
    const context = dragContextRef.current;
    if (context) {
      persistTaskOrder(
        mergeSidebarTaskOrder(
          context.allSessionIds,
          context.visibleSessionIds,
          previewSessionIdsRef.current ?? context.visibleSessionIds
        )
      );
    }
    clearTaskDrag();
  }

  function persistTaskOrder(orderedSessionIds: string[]) {
    const orderBySessionId = new Map(
      orderedSessionIds.map((sessionId, order) => [sessionId, order])
    );
    const previousOrderBySessionId = new Map(
      sessions.map((session) => [session.id, session.order])
    );
    const changedSessionIds = orderedSessionIds.filter(
      (sessionId, order) => previousOrderBySessionId.get(sessionId) !== order
    );
    if (changedSessionIds.length === 0) return;

    const applyOrder = (current: Session[]) =>
      current.map((session) => {
        const order = orderBySessionId.get(session.id);
        return order === undefined || order === session.order
          ? session
          : { ...session, order };
      });
    setSessions(applyOrder);
    setCodexHistorySessions(applyOrder);

    if (!connection) return;
    void Promise.all(
      changedSessionIds.map((sessionId) =>
        api.patchSession(connection, sessionId, {
          order: orderBySessionId.get(sessionId)!,
        })
      )
    ).catch((reorderError) => {
      const restoreOrder = (current: Session[]) =>
        current.map((session) => {
          const order = previousOrderBySessionId.get(session.id);
          return order === undefined || order === session.order
            ? session
            : { ...session, order };
        });
      setSessions(restoreOrder);
      setCodexHistorySessions(restoreOrder);
      setError(
        reorderError instanceof Error
          ? reorderError.message
          : String(reorderError)
      );
    });
  }

  return {
    clearTaskDrag,
    commitTaskDrop,
    commitTaskPreviewDrop,
    previewTaskDrop,
    startTaskDrag,
    taskDragSessionId,
    taskPreviewSessionIds,
  };
}

function sameStringArray(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
