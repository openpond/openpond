import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { SessionSchema, TurnSchema, type Approval, type RuntimeEvent } from "@openpond/contracts";
import { SqliteStore } from "../store/store.js";
import { createBackgroundWorkerQueue } from "./background-worker-queue.js";
import { createCodexBridge } from "./codex-bridge.js";

// A permission wait must belong to the local turn shown in diagnostics, not
// the unrelated provider ID. Otherwise it looks like a stalled evaluation.
test("native approval requests and resolutions bind to their local turn", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "openpond-codex-approval-"));
  const store = new SqliteStore(directory);
  const queue = createBackgroundWorkerQueue({ queueId: "approval-test" });
  const timestamp = "2026-10-10T00:00:00.000Z";
  const approvals: Approval[] = [];
  const events: RuntimeEvent[] = [];
  let requested!: () => void;
  const recorded = new Promise<void>(resolve => { requested = resolve; });
  const bridge = createCodexBridge({
    store,
    providerRuntimeIngestionQueue: queue,
    upsertApproval: async approval => { approvals.push(approval); },
    appendRuntimeEvent: async event => {
      events.push(event);
      if (event.name === "approval.requested") requested();
    },
  });
  try {
    await store.insertSessionAtFront(SessionSchema.parse({
      id: "owned-session", provider: "codex", title: "Evaluation", appId: null, appName: null,
      cwd: directory, codexThreadId: "native-thread", createdAt: timestamp, updatedAt: timestamp,
      status: "active", pinned: false, archived: false, order: 0,
    }));
    await store.insertTurn(TurnSchema.parse({
      id: "local-turn", sessionId: "owned-session", providerTurnId: "native-turn", prompt: "Run",
      startedAt: timestamp, completedAt: null, status: "in_progress", error: null,
    }));
    const response = bridge.handleCodexServerRequest("owned-session", {
      id: 1, method: "item/commandExecution/requestApproval",
      params: { turnId: "native-turn", command: "bounded-workbook-check" },
    });
    await recorded;
    // Let the request register its pending resolver after recording the event.
    await new Promise(resolve => setImmediate(resolve));
    const approval = approvals[0]!;
    await bridge.resolveApproval(approval.id, { decision: "accept" });
    expect(await response).toEqual({ result: { decision: "accept" } });
    expect(approval.turnId).toBe("local-turn");
    expect(events.filter(event => event.name.startsWith("approval.")))
      .toHaveLength(2);
    expect(events.every(event => event.turnId === "local-turn")).toBe(true);
    await store.insertTurn(TurnSchema.parse({
      id: "another-local-turn", sessionId: "another-session", providerTurnId: "another-native-turn", prompt: "Run",
      startedAt: timestamp, completedAt: null, status: "in_progress", error: null,
    }));
    const unrelatedResponse = bridge.handleCodexServerRequest("owned-session", {
      id: 2, method: "item/commandExecution/requestApproval",
      params: { turnId: "another-native-turn", command: "bounded-workbook-check" },
    });
    await expect.poll(() => approvals.length).toBe(3);
    await new Promise(resolve => setImmediate(resolve));
    const unrelated = approvals.at(-1)!;
    expect(unrelated.turnId).toBeNull();
    await bridge.resolveApproval(unrelated.id, { decision: "decline" });
    expect(await unrelatedResponse).toEqual({ result: { decision: "decline" } });
  } finally {
    await queue.drain();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
