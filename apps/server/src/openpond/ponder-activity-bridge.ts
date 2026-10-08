import { createHash } from "node:crypto";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import type { RuntimeEvent } from "@openpond/contracts";
import {
  loadAuthenticatedOpenPondAccountContext,
  type RuntimeAccountContext,
} from "@openpond/runtime";
import { ponderLocalOwner, type PonderLocalOwner } from "./ponder-local-scope.js";

type Activity = {
  id: string;
  source: "local";
  kind: "thread.started" | "run.updated" | "workflow.updated";
  resourceId: string;
  title: string;
  status: string;
  occurredAt: string;
};
type Settings = { watchLocalThreads: boolean; watchWorkflows: boolean };

/** Durable per-account/device outbox. A failed cloud call never blocks a local turn. */
export function createPonderActivityBridge(input: {
  storeDir: string;
  deviceId: string;
  teamId: () => Promise<string | null>;
  request: (
    request: {
      path: string;
      method?: "GET" | "POST";
      body?: Record<string, unknown>;
    },
    context: RuntimeAccountContext,
    teamId: string,
  ) => Promise<Record<string, unknown>>;
  subscribe: (listener: (event: RuntimeEvent) => void) => () => void;
  workflows: () => Promise<{
    workflows: Array<{ id: string; name: string; updatedAt: string }>;
    runs: Array<{
      id: string;
      workflowId: string;
      sessionId: string;
      status: string;
      updatedAt: string;
    }>;
  }>;
  sessionTitle: (id: string) => Promise<string>;
  sessionOwner: (id: string) => Promise<PonderLocalOwner | null>;
  warn: (message: string) => void;
}) {
  let closed = false;
  let tail: Promise<void> = Promise.resolve();
  const queue = (fn: () => Promise<void>) => {
    if (closed) return;
    tail = tail.then(fn).catch(() => input.warn("Ponder Pal activity sync will retry."));
  };
  async function scope() {
    const context = await loadAuthenticatedOpenPondAccountContext();
    const account = context?.accountState;
    if (!account?.activeProfile || account.state !== "signed_in") return null;
    const currentOwner = ponderLocalOwner(
      context,
      input.deviceId,
      await input.teamId(),
      new URL(context.apiBaseUrl).origin,
    );
    if (!currentOwner?.teamId) return null;
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          account.baseUrl,
          account.activeProfile,
          currentOwner.teamId,
          input.deviceId,
          currentOwner.ownerUserId,
        ]),
      )
      .digest("hex");
    return {
      key,
      owner: currentOwner,
      context,
      file: path.join(input.storeDir, "ponder-activity", `${key}.json`),
    };
  }
  async function owns(sessionId: string, owner: PonderLocalOwner) {
    const stored = await input.sessionOwner(sessionId);
    return (
      stored?.installationId === owner.installationId &&
      stored.profileId === owner.profileId &&
      stored.ownerUserId === owner.ownerUserId &&
      stored.teamId === owner.teamId &&
      stored.audience === owner.audience
    );
  }
  async function read(
    file: string,
  ): Promise<{ pending: Activity[]; observed: Record<string, string> }> {
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { pending: [], observed: {} };
      throw error;
    }
  }
  async function save(file: string, value: Awaited<ReturnType<typeof read>>) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file + ".tmp", JSON.stringify(value), { mode: 0o600 });
    await rename(file + ".tmp", file);
  }
  const unsubscribe = input.subscribe((event) => {
    if (closed) return;
    if (
      !event.sessionId ||
      ![
        "session.started",
        "turn.completed",
        "turn.failed",
        "turn.interrupted",
        "turn.started",
      ].includes(event.name)
    )
      return;
    // Capture ownership at arrival, and handle rejection immediately even when
    // an earlier cloud request keeps the serialized queue occupied.
    const capturedScope = scope().then(
      (owner) => ({ owner }),
      (error: unknown) => ({ error }),
    );
    queue(async () => {
      const captured = await capturedScope;
      if ("error" in captured) throw captured.error;
      const owner = captured.owner;
      if (!owner || closed) return;
      if (!(await owns(event.sessionId!, owner.owner))) return;
      const title = await input.sessionTitle(event.sessionId!);
      const state = await read(owner.file);
      const activity: Activity = {
        id: `local:${input.deviceId}:${event.id}`,
        source: "local",
        kind: event.name === "session.started" ? "thread.started" : "run.updated",
        resourceId: event.sessionId!,
        title: title.slice(0, 300),
        status: event.name === "session.started" ? "started" : event.name.slice(5),
        occurredAt: event.timestamp,
      };
      if (!state.pending.some((item) => item.id === activity.id)) state.pending.push(activity);
      await save(owner.file, state);
    });
  });
  async function flush() {
    const owner = await scope();
    if (!owner || closed) return;
    const payload = await input.request(
      { path: "/ponder/settings" },
      owner.context,
      owner.owner.teamId!,
    );
    if ((await scope())?.key !== owner.key) return;
    const settings = payload.settings as Settings;
    const bindingId = payload.bindingId;
    if (typeof bindingId !== "string") throw new Error("Ponder Pal binding missing.");
    const state = await read(owner.file);
    if (!settings.watchLocalThreads) {
      state.pending = [];
      await save(owner.file, state);
      return;
    }
    if (settings.watchWorkflows) {
      const { workflows, runs } = await input.workflows();
      const titles = new Map(workflows.map((workflow) => [workflow.id, workflow.name]));
      for (const row of [
        ...workflows.map((workflow) => ({
          ...workflow,
          status: "available",
          resourceId: workflow.id,
          title: workflow.name,
        })),
        ...runs.map((run) => ({
          ...run,
          resourceId: run.sessionId,
          title: titles.get(run.workflowId) ?? "Workflow run",
        })),
      ]) {
        if (!(await owns(row.resourceId, owner.owner))) continue;
        const key = `workflow:${row.id}`;
        const signature = `${row.updatedAt}:${row.status}`;
        if (state.observed[key] === signature) continue;
        state.pending.push({
          id: `local:${input.deviceId}:${key}:${signature}`,
          source: "local",
          kind: "workflow.updated",
          resourceId: row.resourceId,
          title: row.title.slice(0, 300),
          status: row.status,
          occurredAt: row.updatedAt,
        });
        state.observed[key] = signature;
      }
      await save(owner.file, state);
    }
    if ((await scope())?.key !== owner.key || !state.pending.length) return;
    const batch = state.pending.slice(0, 100);
    const result = await input.request(
      {
        path: "/ponder/activity",
        method: "POST",
        body: { bindingId, items: batch },
      },
      owner.context,
      owner.owner.teamId!,
    );
    if ((await scope())?.key !== owner.key) return;
    const acknowledged = new Set([
      ...(result.delivered as string[]),
      ...(result.ignored as string[]),
    ]);
    state.pending = state.pending.filter((item) => !acknowledged.has(item.id));
    await save(owner.file, state);
  }
  const timer = setInterval(() => queue(flush), 10_000);
  timer.unref();
  queue(flush);
  return {
    close() {
      if (closed) return tail;
      closed = true;
      clearInterval(timer);
      unsubscribe();
      return tail;
    },
    flush: () => {
      queue(flush);
      return tail;
    },
  };
}
