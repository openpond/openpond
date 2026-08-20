import { useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";
import { SessionSchema, type Approval, type RuntimeEvent, type Session } from "@openpond/contracts";
import { api, openEventStream, type ClientConnection } from "../api";
import type { SidebarSectionMenuId } from "../app/app-state";
import { upsertSessionPreservingLocalSidebarState } from "../lib/session-state";

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
  afterSequence: number | null;
  appendEvents: (events: readonly RuntimeEvent[]) => void;
  connection: ClientConnection | null;
  setApprovals: Dispatch<SetStateAction<Approval[]>>;
  setSessions: Dispatch<SetStateAction<Session[]>>;
  setError: Dispatch<SetStateAction<string | null>>;
  onDisconnected?: () => void;
};

export function useRuntimeEvents({
  afterSequence,
  appendEvents,
  connection,
  setApprovals,
  setSessions,
  setError,
  onDisconnected,
}: RuntimeEventsInput) {
  useEffect(() => {
    if (!connection?.token || afterSequence === null) return;
    const eventConnection = connection;
    let disconnectTimer: number | null = null;
    let pendingRuntimeEvents: RuntimeEvent[] = [];
    let flushTimer: number | null = null;
    let refinerPollTimer: number | null = null;
    let refinerPollInFlight = false;
    const pendingRefinerSessions = new Map<string, number>();
    let lastFlushMs = 0;
    const MIN_FLUSH_INTERVAL_MS = 16;

    function clearDisconnectTimer() {
      if (disconnectTimer === null) return;
      window.clearTimeout(disconnectTimer);
      disconnectTimer = null;
    }

    function clearEventStreamError() {
      setError((current) => (current === "Event stream disconnected" ? null : current));
    }

    function flushRuntimeEvents() {
      flushTimer = null;
      const nextEvents = pendingRuntimeEvents;
      pendingRuntimeEvents = [];
      if (nextEvents.length === 0) return;

      lastFlushMs = Date.now();
      appendEvents(nextEvents);
      const liveSessions = liveSessionsFromRuntimeEvents(nextEvents);
      if (liveSessions.length > 0) {
        setSessions((current) =>
          liveSessions.reduce(upsertSessionPreservingLocalSidebarState, current),
        );
      }
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

    function scheduleFlush() {
      const elapsedMs = Date.now() - lastFlushMs;
      if (elapsedMs >= MIN_FLUSH_INTERVAL_MS) {
        if (flushTimer !== null) {
          window.clearTimeout(flushTimer);
          flushTimer = null;
        }
        flushRuntimeEvents();
        return;
      }
      if (flushTimer !== null) return;
      flushTimer = window.setTimeout(
        flushRuntimeEvents,
        MIN_FLUSH_INTERVAL_MS - elapsedMs
      );
    }

    function queueRuntimeEvent(runtimeEvent: RuntimeEvent) {
      trackRefinerEvent(runtimeEvent);
      pendingRuntimeEvents.push(runtimeEvent);
      scheduleFlush();
    }

    function trackRefinerEvent(runtimeEvent: RuntimeEvent) {
      if (!runtimeEvent.sessionId || !runtimeEvent.name.startsWith("harness.refiner.")) return;
      if (
        runtimeEvent.name === "harness.refiner.completed" ||
        runtimeEvent.name === "harness.refiner.failed"
      ) {
        pendingRefinerSessions.delete(runtimeEvent.sessionId);
        return;
      }
      if (
        runtimeEvent.name === "harness.refiner.queued" ||
        runtimeEvent.name === "harness.refiner.started"
      ) {
        pendingRefinerSessions.set(
          runtimeEvent.sessionId,
          typeof runtimeEvent.sequence === "number" ? runtimeEvent.sequence : 0,
        );
        scheduleRefinerCompletionPoll();
      }
    }

    function scheduleRefinerCompletionPoll() {
      if (refinerPollTimer !== null || pendingRefinerSessions.size === 0) return;
      refinerPollTimer = window.setTimeout(() => {
        refinerPollTimer = null;
        void pollRefinerCompletions();
      }, 1_000);
    }

    async function pollRefinerCompletions() {
      if (refinerPollInFlight || pendingRefinerSessions.size === 0) return;
      refinerPollInFlight = true;
      try {
        await Promise.all(
          [...pendingRefinerSessions].map(async ([sessionId, afterSequence]) => {
            const page = await api.runtimeEventsPage(eventConnection, {
              sessionId,
              afterSequence,
              limit: 100,
            });
            for (const entry of page.events) {
              const runtimeEvent = entry.event;
              pendingRefinerSessions.set(
                sessionId,
                Math.max(pendingRefinerSessions.get(sessionId) ?? 0, entry.sequence),
              );
              queueRuntimeEvent(runtimeEvent);
            }
          }),
        );
      } catch {
        // The event stream remains primary; retry only while a Refiner is pending.
      } finally {
        refinerPollInFlight = false;
        scheduleRefinerCompletionPoll();
      }
    }

    function flushPendingOnVisibilityChange() {
      if (flushTimer !== null) {
        window.clearTimeout(flushTimer);
        flushTimer = null;
      }
      flushRuntimeEvents();
    }
    document.addEventListener("visibilitychange", flushPendingOnVisibilityChange);

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
      },
      { afterSequence },
    );
    return () => {
      clearDisconnectTimer();
      if (flushTimer !== null) window.clearTimeout(flushTimer);
      if (refinerPollTimer !== null) window.clearTimeout(refinerPollTimer);
      flushTimer = null;
      refinerPollTimer = null;
      pendingRuntimeEvents = [];
      document.removeEventListener("visibilitychange", flushPendingOnVisibilityChange);
      source.close();
    };
  }, [afterSequence, appendEvents, connection, onDisconnected, setApprovals, setError, setSessions]);
}

export function liveSessionsFromRuntimeEvents(events: RuntimeEvent[]): Session[] {
  const sessions = new Map<string, Session>();
  for (const runtimeEvent of events) {
    const data = runtimeEvent.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) continue;
    const sessionKey =
      runtimeEvent.name === "session.started" ||
      runtimeEvent.name === "session.title.updated"
        ? "session"
        : runtimeEvent.name === "subagent.started" ||
          runtimeEvent.name === "subagent.failed"
        ? "childSession"
        : null;
    if (!sessionKey) continue;
    const parsed = SessionSchema.safeParse(
      (data as Record<string, unknown>)[sessionKey]
    );
    if (parsed.success) sessions.set(parsed.data.id, parsed.data);
  }
  return [...sessions.values()];
}
