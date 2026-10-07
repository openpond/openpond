import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { RuntimeEvent } from "@openpond/contracts";
import type { streamOpenPondHostedChatTurn } from "@openpond/runtime";
import { SqliteStore } from "../apps/server/src/store/store";
import { createSessionStore } from "../apps/server/src/store/session-store";
import { createSessionTitleService, withPendingAutoTitle } from "../apps/server/src/session-title-service";
import { event } from "../apps/server/src/utils";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(stream: typeof streamOpenPondHostedChatTurn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openpond-title-"));
  const store = new SqliteStore(dir);
  cleanup.push(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  const events: RuntimeEvent[] = [];
  const appendRuntimeEvent = async (value: RuntimeEvent) => { events.push(value); await store.appendRuntimeEvent(value); };
  const sessions = createSessionStore({ store, defaultSessionCwd: () => "/tmp", appendRuntimeEvent });
  const service = createSessionTitleService({ store, appendRuntimeEvent, logger: { warn: () => {} }, stream });
  cleanup.push(service.close);
  return { store, events, sessions, service };
}

describe("automatic session title ownership", () => {
  // A transient request failure must not permanently freeze a first-words title.
  test("retries a failed request, deduplicates scheduling and persists the generated title", async () => {
    let calls = 0;
    const f = await fixture(async function* () {
      if (++calls === 1) throw new Error("temporary outage");
      yield { type: "text_delta", text: "Generated task title" };
    });
    const session = await f.sessions.createSession(withPendingAutoTitle({ provider: "claude-code", autoTitlePrompt: "Please explain how pipeline updates work" }));
    const first = f.service.schedule(session.id);
    expect(f.service.schedule(session.id)).toBe(first);
    await first;
    expect(calls).toBe(2);
    expect((await f.store.getSession(session.id))?.metadata).toMatchObject({ titleSource: "model", autoTitle: null });
    expect((await f.store.getSession(session.id))?.title).toBe("Generated task title");
    expect(f.events.filter(e => e.name === "session.title.updated").map(e => e.data?.titleSource)).toEqual(["fallback", "model"]);
  }, 10_000);

  // Even renaming to the same visible temporary text is an explicit ownership change.
  test("a manual rename during generation wins atomically and prevents recovery", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let started = false;
    const f = await fixture(async function* () { started = true; await gate; yield { type: "text_delta", text: "Unwanted generated title" }; });
    const session = await f.sessions.createSession(withPendingAutoTitle({ provider: "codex", autoTitlePrompt: "Rename protection" }));
    const job = f.service.schedule(session.id);
    await vi.waitFor(() => expect(started).toBe(true));
    await f.sessions.patchSession(session.id, { title: session.title });
    release();
    await job;
    await f.service.recover();
    expect((await f.store.getSession(session.id))?.title).toBe(session.title);
    expect((await f.store.getSession(session.id))?.metadata).toMatchObject({ titleSource: "manual", autoTitle: null });
    expect(f.events.filter(e => e.name === "session.title.updated")).toHaveLength(0);
  });

  // Repair is grounded in saved fallback events; imported or renamed chats stay intact.
  test("recovers recorded temporary titles while preserving imports and renamed titles", async () => {
    const f = await fixture(async function* () { yield { type: "text_delta", text: "Recovered task title" }; });
    const old = await f.sessions.createSession({ provider: "claude-code", title: "Temporary first words" });
    const imported = await f.sessions.createSession({ provider: "codex", title: "Native imported title" });
    const renamed = await f.sessions.createSession({ provider: "codex", title: "User chosen name" });
    for (const session of [old, renamed]) {
      await f.store.insertTurn({ id: `turn-${session.id}`, sessionId: session.id, providerTurnId: null, prompt: "Explain the pipeline", startedAt: session.createdAt, completedAt: null, status: "in_progress", error: null, metadata: {}, createImproveRun: null });
      await f.store.appendRuntimeEvent(event({ sessionId: session.id, turnId: `turn-${session.id}`, name: "turn.started", source: "server" }));
      await f.store.appendRuntimeEvent(event({ sessionId: session.id, name: "session.title.updated", source: "server", data: { titleSource: "fallback", session: { ...session, title: old.title } } }));
    }
    await f.service.recover();
    await f.service.schedule(old.id);
    expect((await f.store.getSession(old.id))?.title).toBe("Recovered task title");
    expect((await f.store.getSession(imported.id))?.title).toBe(imported.title);
    expect((await f.store.getSession(renamed.id))?.title).toBe(renamed.title);
  });
});
