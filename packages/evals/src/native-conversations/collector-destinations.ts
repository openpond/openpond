import type { CollectorConnection, CollectorDestinations } from "./collector-contracts.js";

/** Only destinations explicitly returned for this exact authenticated source. */
export function collectorDestinations(connection: CollectorConnection, remote: {
  id: string; teamId: string; projectId: string; machineId: string;
  sourceInstanceId: string; sourceRoot: string; source: string; taskDatasetId: string | null;
  conversationDatasetId: string | null;
}): CollectorDestinations {
  if (remote.id !== connection.id || remote.teamId !== connection.teamId ||
      remote.projectId !== connection.projectId || remote.machineId !== connection.source.machineId ||
      remote.sourceInstanceId !== connection.source.instanceId || remote.sourceRoot !== connection.source.root || remote.source !== connection.source.source)
    throw new Error("The hosted destination belongs to another source or workspace.");
  return { taskDatasetId: remote.taskDatasetId, conversationDatasetId: remote.conversationDatasetId };
}

export function collectorDestinationLinks(connection: CollectorConnection) {
  const absent = { tasks: null, conversations: null };
  if (!connection.accountBaseUrl || !connection.destinations) return absent;
  let origin: URL;
  try { origin = new URL(connection.accountBaseUrl); } catch { return absent; }
  if ((origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname))) ||
      origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") return absent;
  const link = (id: string | null) => id
    ? `${origin.origin}/console/datasets/${encodeURIComponent(id)}/tasks?project=${encodeURIComponent(connection.projectId)}&connection=${encodeURIComponent(connection.id)}`
    : null;
  return { tasks: link(connection.destinations.taskDatasetId), conversations: link(connection.destinations.conversationDatasetId) };
}
