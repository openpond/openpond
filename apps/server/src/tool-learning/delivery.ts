import { ToolLearningLocalStore } from "openpond-sdk/tool-learning/node";
import {
  toolLearningContentHash,
  OpenPondToolLearningError,
  type ToolLearningInstallation,
} from "openpond-sdk/tool-learning";
import {
  toolLearningProducer,
  loadToolLearningCredential,
  saveToolLearningCredential,
  type ToolLearningCredentialRecord,
} from "./local.js";
import { contentHash } from "@openpond/harness";

export function configureLocalToolLearning(
  store: ToolLearningLocalStore,
  record: ToolLearningCredentialRecord,
  installation: ToolLearningInstallation | null,
) {
  const registration = record.prepared.registration;
  if (!["openpond", "claude_code", "opencode", "codex"].includes(registration.client))
    throw new Error("This client has not been qualified for installation.");
  return store.configure({
    schemaVersion: "openpond.localToolLearningInstallation.v1",
    id: registration.installationId,
    teamId: record.teamId,
    projectId: record.projectId,
    client: registration.client,
    workspaceRoot: record.workspaceRoot,
    enabled: record.locallyEnabled && installation?.state === "enabled",
    policy: registration.collectionPolicy,
    createdAt: installation?.createdAt ?? new Date().toISOString(),
  });
}

/** Only a fully identity-checked, authenticated receipt can remove queue data.
 * Requests have stable IDs across process restarts and overlapping deliveries. */
export async function flushToolLearning(
  home: string,
  store: ToolLearningLocalStore,
  record: ToolLearningCredentialRecord,
  signal?: AbortSignal,
) {
  const client = toolLearningProducer(record),
    id = record.prepared.registration.installationId;

  if (!record.locallyEnabled) {
    configureLocalToolLearning(store, record, null);
    return {
      installationId: id,
      deliveredEvents: 0,
      rejectedEvents: 0,
      local: store.status(id),
      learningEnrollment: false,
    };
  }
  const suspend = async () => {
    configureLocalToolLearning(store, record, null);
    const saved = await loadToolLearningCredential(home, id);
    if (saved.value.locallyEnabled)
      await saveToolLearningCredential(
        home,
        { ...saved.value, locallyEnabled: false },
        saved.revision,
      );
  };
  let remote: ToolLearningInstallation;
  try {
    remote = await client.installation(id, signal);
  } catch (error) {
    if (error instanceof OpenPondToolLearningError && [401, 403].includes(error.status))
      await suspend();
    throw error;
  }
  if (remote.state !== "enabled") await suspend();
  if (
    remote.collectionPolicyHash !==
    toolLearningContentHash(record.prepared.registration.collectionPolicy)
  ) {
    await suspend();
    throw new Error(
      "Tool learning collection policy changed. Reconfigure this installation before uploading.",
    );
  }
  configureLocalToolLearning(store, record, remote);
  let deliveredEvents = 0,
    rejectedEvents = 0;
  // One finite process performs at most 16 pages; larger backlogs remain
  // durable for the next foreground flush or hook, without spawning a daemon.
  for (let page = 0; page < 16; page++) {
    const events = store.pending(id);
    if (!events.length) break;
    const receipt = await client
      .append(
        {
          schemaVersion: "openpond.toolEpisodeAppend.v1",
          installationId: id,
          operationId: `tool-append-${contentHash([id, events.map((event) => [event.eventId, event.contentHash])])}`,
          events,
        },
        signal,
      )
      .catch(async (error) => {
        if (error instanceof OpenPondToolLearningError && [401, 403].includes(error.status))
          await suspend();
        throw error;
      });
    store.acknowledge(id, receipt.events);
    deliveredEvents += receipt.events.filter((event) => event.state !== "privacy_rejected").length;
    rejectedEvents += receipt.events.filter((event) => event.state === "privacy_rejected").length;
  }
  return {
    installationId: id,
    deliveredEvents,
    rejectedEvents,
    local: store.status(id),
    learningEnrollment: false,
  };
}
