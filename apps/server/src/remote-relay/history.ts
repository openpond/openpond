import { TaskInputSchema, type RemoteHistoryItem, type RemoteHistoryPage, type RuntimeEvent } from "@openpond/contracts";
import { randomUUID } from "node:crypto";
import type { SqliteStore } from "../store/store.js";
import { deviceOwnsLocalSession, type DeviceLocalOwner } from "./local-scope.js";
import { observeRemoteHistorySequence, remoteHistoryGeneration } from "./catalog.js";

/** Allowlist projection: no raw args, file paths, provider payloads or internal events. */
export function projectRemoteEvent(event: RuntimeEvent, sequence: number): RemoteHistoryItem | null {
  if (event.name === "task.input") {
    const data = event.data as Record<string, unknown> | undefined;
    const parsed = TaskInputSchema.safeParse(data?.input);
    if (!parsed.success || parsed.data.senderKind === "user" || !parsed.data.senderSessionId) return null;
    const input = parsed.data;
    const delivery = data?.delivery as {direction?: unknown; peer?: {sessionId?: unknown; title?: unknown; provider?: unknown}} | undefined;
    const sent = delivery?.direction === "sent" && event.sessionId === input.senderSessionId;
    if (!sent && event.sessionId !== input.sessionId) return null;
    const peerId = sent ? input.sessionId : input.senderSessionId!;
    const peer = delivery?.peer;
    const matches = peer?.sessionId === peerId;
    return {id: event.id, sequence, timestamp: event.timestamp, type: "tool",
      coordinationKind: sent ? "sent" : "received", coordinationInputId: input.id, peerSessionId: peerId,
      peerTitle: matches && typeof peer?.title === "string" ? peer.title.slice(0, 1000) : "Another task",
      ...(matches && typeof peer?.provider === "string" ? {peerProvider: peer.provider.slice(0, 100)} : {}),
      text: input.body.slice(0, 100000), status: event.status, ...(event.turnId ? {turnId: event.turnId} : {})};
  }
  const userMessage = event.name === "turn.started" && typeof event.args?.prompt === "string";
  const message = userMessage || event.name === "assistant.delta";
  const tool = ["tool.started", "tool.completed"].includes(event.name);
  const state = ["turn.started", "turn.completed", "turn.failed", "turn.interrupted"].includes(event.name);
  const approval = ["approval.requested", "approval.resolved"].includes(event.name);
  if (!message && !tool && !state && !approval) return null;
  const data = event.data && typeof event.data === "object" ? event.data as Record<string, unknown> : {};
  const content = !message ? "" : userMessage ? event.args!.prompt as string : event.output ?? (typeof data.text === "string" ? data.text : "");
  // Runtime event status records processing; turn names carry the lifecycle outcome.
  const turnStatus = event.name === "turn.started" ? "in_progress" : event.name === "turn.completed" ? "completed"
    : event.name === "turn.failed" ? "failed" : event.name === "turn.interrupted" ? "interrupted" : undefined;
  const status = turnStatus ?? (event.name === "approval.requested" ? "pending" : event.name === "approval.resolved"
    ? typeof data.status === "string" ? data.status : data.decision === "accept" ? "accepted"
      : data.decision === "acceptForSession" ? "accepted_for_session" : data.decision === "decline" ? "declined"
        : data.decision === "cancel" ? "cancelled" : event.status
    : event.status);
  return { id: event.id, sequence, type: message ? "message" : tool ? "tool" : approval ? "approval" : "state",
    timestamp: event.timestamp,
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(message ? { messageId: userMessage ? `user:${event.turnId ?? event.id}` :
      `assistant:${typeof data.nativeMessageId === "string" ? data.nativeMessageId : typeof data.itemId === "string" ? data.itemId : event.turnId ?? event.id}`,
      textMode: data.nativeMessageSnapshot === true ? "replace" as const : "append" as const } : {}),
    ...(message ? { role: userMessage ? "user" as const : "assistant" as const } : {}),
    ...(content ? { text: content } : {}),
    ...(tool && event.action ? { toolName: event.action.slice(0, 200) } : {}),
    ...(event.name === "tool.completed" && event.action === "openpond_start_agent" && event.status === "completed"
      && typeof event.args?.title === "string" ? {coordinationKind: "started" as const,
        peerTitle: event.args.title.slice(0, 1000)} : {}),
    ...(status ? { status } : {}),
    ...(approval && typeof (data.approvalId ?? data.id) === "string" ? { approvalId: (data.approvalId ?? data.id) as string } : {}),
  };
}

/** Approval callbacks carry provider IDs; viewers address canonical local turns. */
export async function normalizeRemoteEventTurn(store: Pick<SqliteStore, "turnByProviderTurnId">, event: RuntimeEvent): Promise<RuntimeEvent> {
  if (!["approval.requested", "approval.resolved"].includes(event.name) || !event.turnId) return event;
  const turn = await store.turnByProviderTurnId(event.turnId);
  return turn && turn.sessionId === event.sessionId ? { ...event, turnId: turn.id } : event;
}

/** Stable fragments preserve one logical message without unbounded wire frames. */
export function* projectRemoteEventChunks(event: RuntimeEvent, sequence: number, offset = 0): Generator<RemoteHistoryItem> {
  const item = projectRemoteEvent(event, sequence);
  if (!item) return;
  if (!item.text || (item.type !== "message" && !item.coordinationKind)) { yield item; return; }
  for (let start = offset; start < item.text.length; start += 8_000) {
    yield { ...item, fragmentIndex: Math.floor(start / 8_000), fragmentCount: Math.ceil(item.text.length / 8_000), id: `${item.id}:${start}`, text: item.text.slice(start, start + 8_000),
      textMode: start === 0 ? item.textMode : "append" };
  }
}

export async function readRemoteHistory(input: {
  store: Pick<SqliteStore, "getSession" | "runtimeEventPageRows" | "latestEventSequence" | "turnByProviderTurnId">;
  owner: DeviceLocalOwner; ponder?: import("../openpond/local-ponder-contract.js").LocalPonderCoordinator | null; taskId: string; cursor: string | null;
  outputs?(session: import("@openpond/contracts").Session): Promise<import("@openpond/contracts").FileOutputRef[]>;
}): Promise<RemoteHistoryPage> {
  const session = await input.store.getSession(input.taskId);
  if (!session || !deviceOwnsLocalSession(session, input.owner)) throw new Error("remote_task_not_owned");
  const currentSequence = await input.store.latestEventSequence();
  observeRemoteHistorySequence(currentSequence);
  if (session.systemKind === "openpond.ponder" && (!input.ponder?.remoteAccessEnabled
    || input.ponder.sessionId !== session.id || session.metadata?.localPonderCoordinatorId !== input.ponder.id))
    throw new Error("remote_ponder_access_off");
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
    const projected = projectRemoteEventChunks(await normalizeRemoteEventTurn(input.store, entry.event), entry.sequence, nextFragment);
    for (const item of projected) {
      if (entry.event.name === "turn.completed") item.artifactIds = outputs.filter(output => output.sourceTurnId === entry.event.turnId).map(output => output.id).slice(0, 100);
      const size = Buffer.byteLength(JSON.stringify(item));
      if (bytes + size > 200_000) { finished = false; break outer; }
      items.push(item); bytes += size;
      if (item.type === "message" || item.coordinationKind) nextFragment += item.text?.length ?? 0;
    }
    last = entry.sequence; nextFragment = 0;
    if (last >= watermark) { finished = true; break; }
  }
  return { snapshotId, taskId: session.id, historyGeneration: generation, watermark,
    items,
    nextCursor: finished ? null : Buffer.from(JSON.stringify({ generation, taskId: session.id, after: last, watermark, snapshotId, fragment: nextFragment })).toString("base64url"),
    capturedAt: new Date().toISOString(), provenance: "live" };
}
