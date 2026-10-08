import type { RemoteHistoryItem, RemoteHistoryPage, RuntimeEvent } from "@openpond/contracts";
import { randomUUID } from "node:crypto";
import type { SqliteStore } from "../store/store.js";
import { deviceOwnsLocalSession, type DeviceLocalOwner } from "./local-scope.js";
import { observeRemoteHistorySequence, remoteHistoryGeneration } from "./catalog.js";

/** Allowlist projection: no raw args, file paths, provider payloads or internal events. */
export function projectRemoteEvent(event: RuntimeEvent, sequence: number): RemoteHistoryItem | null {
  const userMessage = event.name === "turn.started" && typeof event.args?.prompt === "string";
  const message = userMessage || event.name === "assistant.delta";
  const tool = ["tool.started", "tool.completed"].includes(event.name);
  const state = ["turn.started", "turn.completed", "turn.failed", "turn.interrupted"].includes(event.name);
  const approval = ["approval.requested", "approval.resolved"].includes(event.name);
  if (!message && !tool && !state && !approval) return null;
  const data = event.data && typeof event.data === "object" ? event.data as Record<string, unknown> : {};
  const content = !message ? "" : userMessage ? event.args!.prompt as string : event.output ?? (typeof data.text === "string" ? data.text : "");
  return { id: event.id, sequence, type: message ? "message" : tool ? "tool" : approval ? "approval" : "state",
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(message ? { messageId: userMessage ? `user:${event.turnId ?? event.id}` :
      `assistant:${typeof data.nativeMessageId === "string" ? data.nativeMessageId : typeof data.itemId === "string" ? data.itemId : event.turnId ?? event.id}`,
      textMode: data.nativeMessageSnapshot === true ? "replace" as const : "append" as const } : {}),
    ...(message ? { role: userMessage ? "user" as const : "assistant" as const } : {}),
    ...(content ? { text: content } : {}),
    ...(tool && event.action ? { toolName: event.action.slice(0, 200) } : {}),
    ...(event.status ? { status: event.status } : {}),
    ...(approval && typeof (data.approvalId ?? data.id) === "string" ? { approvalId: (data.approvalId ?? data.id) as string } : {}),
  };
}

/** Stable fragments preserve one logical message without unbounded wire frames. */
export function* projectRemoteEventChunks(event: RuntimeEvent, sequence: number, offset = 0): Generator<RemoteHistoryItem> {
  const item = projectRemoteEvent(event, sequence);
  if (!item) return;
  if (!item.text || item.type !== "message") { yield item; return; }
  for (let start = offset; start < item.text.length; start += 8_000) {
    yield { ...item, fragmentIndex: Math.floor(start / 8_000), fragmentCount: Math.ceil(item.text.length / 8_000), id: `${item.id}:${start}`, text: item.text.slice(start, start + 8_000),
      textMode: start === 0 ? item.textMode : "append" };
  }
}

export async function readRemoteHistory(input: {
  store: Pick<SqliteStore, "getSession" | "runtimeEventPageRows" | "latestEventSequence">;
  owner: DeviceLocalOwner; taskId: string; cursor: string | null;
  outputs?(session: import("@openpond/contracts").Session): Promise<import("@openpond/contracts").FileOutputRef[]>;
}): Promise<RemoteHistoryPage> {
  const session = await input.store.getSession(input.taskId);
  if (!session || !deviceOwnsLocalSession(session, input.owner)) throw new Error("remote_task_not_owned");
  const currentSequence = await input.store.latestEventSequence();
  observeRemoteHistorySequence(currentSequence);
  const generation = remoteHistoryGeneration(session);
  const outputs = input.outputs ? await input.outputs(session) : [];
  let after = 0;
  let fragment = 0;
  let watermark = currentSequence;
  let snapshotId: string = randomUUID();
  if (input.cursor) {
    const decoded = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")) as { generation: string; taskId: string; after: number; watermark: number; snapshotId: string; fragment?: number };
    if (decoded.generation !== generation || decoded.taskId !== input.taskId || !Number.isSafeInteger(decoded.after)
      || decoded.after < 0 || !Number.isSafeInteger(decoded.watermark) || decoded.watermark < decoded.after
      || typeof decoded.snapshotId !== "string" || !Number.isSafeInteger(decoded.fragment ?? 0) || (decoded.fragment ?? 0) < 0) throw new Error("remote_history_resync_required");
    after = decoded.after; fragment = decoded.fragment ?? 0; watermark = decoded.watermark; snapshotId = decoded.snapshotId;
  }
  const page = await input.store.runtimeEventPageRows({ sessionId: input.taskId, afterSequence: after, beforeSequence: null, limit: 100 });
  const items: RemoteHistoryItem[] = [];
  let bytes = 0;
  let last = after;
  let nextFragment = fragment;
  let finished = page.entries.length < 100;
  outer: for (const entry of page.entries) {
    if (entry.sequence > watermark) { finished = true; break; }
    const projected = projectRemoteEventChunks(entry.event, entry.sequence, nextFragment);
    for (const item of projected) {
      if (entry.event.name === "turn.completed") item.artifactIds = outputs.filter(output => output.sourceTurnId === entry.event.turnId).map(output => output.id).slice(0, 100);
      const size = Buffer.byteLength(JSON.stringify(item));
      if (bytes + size > 200_000) { finished = false; break outer; }
      items.push(item); bytes += size;
      if (item.type === "message") nextFragment += item.text?.length ?? 0;
    }
    last = entry.sequence; nextFragment = 0;
    if (last >= watermark) { finished = true; break; }
  }
  return { snapshotId, taskId: session.id, historyGeneration: generation, watermark,
    items,
    nextCursor: finished ? null : Buffer.from(JSON.stringify({ generation, taskId: session.id, after: last, watermark, snapshotId, fragment: nextFragment })).toString("base64url"),
    capturedAt: new Date().toISOString(), provenance: "live" };
}
