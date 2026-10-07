import type { Session } from "@openpond/contracts";
import type { SqliteStore } from "./store/store.js";

/** Recover ownership from recorded title events, never from a title's wording. */
export async function recoverTemporarySessionTitle(
  store: Pick<SqliteStore, "runtimeEventsForSession" | "getTurn" | "updateSession">,
  session: Session,
): Promise<Session> {
  if (session.metadata?.titleSource || session.archived || session.hiddenFromDefaultSidebar) return session;
  const titles = await store.runtimeEventsForSession(session.id, { names: ["session.title.updated"] });
  const last = titles.at(-1)?.data as Record<string, unknown> | undefined;
  const previous = last?.session as Session | undefined;
  if (last?.titleSource !== "fallback" || previous?.title !== session.title) return session;
  const [start] = await store.runtimeEventsForSession(session.id, { names: ["turn.started"], limit: 1 });
  const turn = start?.turnId ? await store.getTurn(start.turnId) : null;
  if (!turn?.prompt.trim()) return session;
  return await store.updateSession(session.id, (current) => {
    if (current.metadata?.titleSource || current.title !== session.title) return current;
    return { ...current, metadata: { ...current.metadata, titleSource: "fallback",
      autoTitle: { prompt: turn.prompt.slice(0, 20_000), title: current.title, attempts: 0, nextAttemptAt: 0 } } };
  }) ?? session;
}
