import { CollectorStore, collectorMachineId, type CollectorConnection, type NativeSource } from "@openpond/evals/native-conversations";
import { contentHash } from "@openpond/harness";

/** Reauthorization retains scope; changing it belongs to explicit Connect setup. */
export async function retainedReconnect(directory: string, id: string | undefined) {
  const store = await CollectorStore.open(directory);
  let connection: CollectorConnection | undefined;
  try { connection = store.connections().find(item => item.id === id); }
  finally { store.close(); }
  if (!connection) throw new Error("Select a retained connection from openpond import status.");
  if (connection.source.machineId !== await collectorMachineId(directory))
    throw new Error("This connection belongs to another machine. Use explicit Connect setup.");
  if (!connection.accountBaseUrl)
    throw new Error("The original sign-in destination is unavailable. Use explicit Connect setup.");
  return connection;
}

export function assertReconnectSource(connection: CollectorConnection, source: NativeSource | undefined) {
  if (!source?.available || !source.capabilities.history || source.source !== connection.source.source || source.machineId !== connection.source.machineId || source.instanceId !== connection.source.instanceId || source.root !== connection.source.root)
    throw new Error("The retained source is unavailable or its identity changed. Restore its original location or use explicit Connect setup.");
}

export async function assertReconnectUnchanged(directory: string, expected: CollectorConnection) {
  const current = await retainedReconnect(directory, expected.id);
  if (contentHash(current) !== contentHash(expected))
    throw new Error("The connection changed during sign-in. Reconnect again after reviewing its current scope.");
}
