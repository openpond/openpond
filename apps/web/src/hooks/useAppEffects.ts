import { useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { Approval, RuntimeEvent } from "@openpond/contracts";
import { openEventStream, type ClientConnection } from "../api";
import type { SidebarSectionMenuId } from "../app/app-state";

type ShortcutInput = {
  searchOpen: boolean;
  sectionMenuOpen: SidebarSectionMenuId | null;
  setSectionMenuOpen: Dispatch<SetStateAction<SidebarSectionMenuId | null>>;
  setSearchOpen: Dispatch<SetStateAction<boolean>>;
  setQuery: Dispatch<SetStateAction<string>>;
};

export function useCommandShortcuts({
  searchOpen,
  sectionMenuOpen,
  setSectionMenuOpen,
  setSearchOpen,
  setQuery,
}: ShortcutInput) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSectionMenuOpen(null);
        setSearchOpen((open) => !open);
        return;
      }
      if (event.key === "Escape" && searchOpen) {
        event.preventDefault();
        setSearchOpen(false);
        setQuery("");
        setSectionMenuOpen(null);
        return;
      }
      if (event.key === "Escape" && sectionMenuOpen) {
        event.preventDefault();
        setSectionMenuOpen(null);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [searchOpen, sectionMenuOpen, setQuery, setSearchOpen, setSectionMenuOpen]);
}

type RuntimeEventsInput = {
  connection: ClientConnection | null;
  setEvents: Dispatch<SetStateAction<RuntimeEvent[]>>;
  setApprovals: Dispatch<SetStateAction<Approval[]>>;
  setError: Dispatch<SetStateAction<string | null>>;
  onDisconnected?: () => void;
};

export function useRuntimeEvents({ connection, setEvents, setApprovals, setError, onDisconnected }: RuntimeEventsInput) {
  useEffect(() => {
    if (!connection?.token) return;
    let disconnectTimer: number | null = null;
    let pendingRuntimeEvents: RuntimeEvent[] = [];
    let flushFrame: number | null = null;

    function clearDisconnectTimer() {
      if (disconnectTimer === null) return;
      window.clearTimeout(disconnectTimer);
      disconnectTimer = null;
    }

    function clearEventStreamError() {
      setError((current) => (current === "Event stream disconnected" ? null : current));
    }

    function flushRuntimeEvents() {
      flushFrame = null;
      const nextEvents = pendingRuntimeEvents;
      pendingRuntimeEvents = [];
      if (nextEvents.length === 0) return;

      setEvents((current) => [...current, ...nextEvents]);
      setApprovals((current) => {
        let next = current;
        for (const runtimeEvent of nextEvents) {
          if (runtimeEvent.name === "approval.requested" && runtimeEvent.data) {
            next = [runtimeEvent.data as Approval, ...next];
          }
          if (runtimeEvent.name === "approval.resolved" && runtimeEvent.data && typeof runtimeEvent.data === "object") {
            const data = runtimeEvent.data as { approvalId?: string };
            if (data.approvalId) next = next.filter((approval) => approval.id !== data.approvalId);
          }
        }
        return next;
      });
    }

    function queueRuntimeEvent(runtimeEvent: RuntimeEvent) {
      pendingRuntimeEvents.push(runtimeEvent);
      if (flushFrame !== null) return;
      flushFrame = window.requestAnimationFrame(flushRuntimeEvents);
    }

    const source = openEventStream(
      connection,
      (runtimeEvent) => {
        clearDisconnectTimer();
        clearEventStreamError();
        queueRuntimeEvent(runtimeEvent);
      },
      () => {
        clearDisconnectTimer();
        disconnectTimer = window.setTimeout(() => {
          if (!source.isOpen()) {
            setError("Event stream disconnected");
            onDisconnected?.();
          }
        }, 2000);
      },
      () => {
        clearDisconnectTimer();
        clearEventStreamError();
      }
    );
    return () => {
      clearDisconnectTimer();
      if (flushFrame !== null) window.cancelAnimationFrame(flushFrame);
      source.close();
    };
  }, [connection, onDisconnected, setApprovals, setError, setEvents]);
}
