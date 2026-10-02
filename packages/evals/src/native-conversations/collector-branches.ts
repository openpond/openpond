import { z } from "zod";
import { CollectorStore } from "./collector-store.js";
import { CollectorErrors } from "./collector-errors.js";
import { inspectSessionBranches, listSessions, readSession } from "./history.js";
import type { NativeBranchAnchor, NativeBranchChoice, NativeSession, NativeSource } from "./contracts.js";

const anchorSchema = z.object({ leafId: z.string().min(1).max(200), chainHash: z.string().regex(/^[a-f0-9]{64}$/), sourceInstanceId: z.string().min(1) }).strict();
const key = (connectionId: string, nativeSessionId: string) => `branch:${JSON.stringify([connectionId, nativeSessionId])}`;

export function collectorBranchAnchor(store: CollectorStore, connectionId: string, nativeSessionId: string): NativeBranchAnchor | undefined {
  const value = store.setting(key(connectionId, nativeSessionId));
  if (!value) return undefined;
  const anchor = anchorSchema.parse(JSON.parse(value));
  const connection = store.connections().find(item => item.id === connectionId);
  return connection?.source.instanceId === anchor.sourceInstanceId ? { leafId: anchor.leafId, chainHash: anchor.chainHash } : undefined;
}

async function findSession(source: NativeSource, nativeSessionId: string): Promise<NativeSession> {
  if (source.source !== "claude_code") throw new Error("Branch selection is currently supported for Claude Code.");
  let cursor: string | undefined;
  const matches: NativeSession[] = [];
  do {
    const page = await listSessions(source, { cursor, limit: 100 });
    matches.push(...page.items.filter(item => item.nativeSessionId === nativeSessionId));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  if (matches.length !== 1) throw new Error("Select exactly one native session in this connection's source location.");
  return matches[0]!;
}

export async function inspectCollectorBranches(directory: string, connectionId: string, nativeSessionId: string) {
  const store = await CollectorStore.open(directory);
  try {
    const connection = store.connections().find(item => item.id === connectionId);
    if (!connection) throw new Error("Select a connection from openpond import status.");
    const session = await findSession(connection.source, nativeSessionId);
    return { session, ...await inspectSessionBranches(connection.source, session) };
  } finally { store.close(); }
}

/** A paused connection fences earlier in-flight admission before narrowing its branch authority. */
export async function selectCollectorBranch(directory: string, connectionId: string, nativeSessionId: string, choice: NativeBranchChoice) {
  const store = await CollectorStore.open(directory);
  try {
    const connection = store.connections().find(item => item.id === connectionId);
    if (!connection || connection.state !== "paused") throw new Error(`Pause this connection first: openpond import pause ${connectionId}`);
    const session = await findSession(connection.source, nativeSessionId);
    const inspected = await inspectSessionBranches(connection.source, session);
    const branch = inspected.branches.find(item => item.leafId === choice.leafId);
    if (inspected.revision !== choice.revision || !branch) throw new Error("This conversation changed. Refresh its branches and choose again.");
    await readSession(connection.source, session, { branchLeafId: choice.leafId, expectedBranchRevision: choice.revision });
    store.database.exec("BEGIN IMMEDIATE");
    try {
      const current = store.connections().find(item => item.id === connectionId);
      if (!current || current.state !== "paused" || current.revision !== connection.revision || current.source.instanceId !== connection.source.instanceId) throw new Error("Connection changed during branch selection. Refresh and try again.");
      store.set(key(connectionId, nativeSessionId), JSON.stringify({ leafId: branch.leafId, chainHash: branch.chainHash, sourceInstanceId: connection.source.instanceId }));
      // Never admit previously queued sibling evidence after a changed choice.
      for (const table of ["source_scans", "checkpoints", "pending"]) store.database.prepare(`DELETE FROM ${table} WHERE connection_id=?`).run(connectionId);
      const errors = new CollectorErrors(store);
      errors.set(connectionId, "source", errors.source(connectionId));
      store.progress.reset(connectionId);
      errors.set(connectionId, "admission", null);
      store.database.exec("COMMIT");
    } catch (error) { store.database.exec("ROLLBACK"); throw error; }
    return { connectionId, nativeSessionId, leafId: branch.leafId, state: "paused" as const };
  } finally { store.close(); }
}
