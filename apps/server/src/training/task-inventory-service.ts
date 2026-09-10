import { TaskDataRecordSchema } from "@openpond/contracts";
import { TaskInventoryQuerySchema, summarizeTaskScoring, taskConfiguration } from "openpond-sdk/taskset-drafts";
import type { SqliteStore } from "../store/store.js";
import type { LocalTaskInventorySource } from "../store/store-task-inventory.js";
import type { createDatasetArtifactService } from "./dataset-artifact-service.js";

export function taskInventoryRequest(url: URL | undefined) {
  if (!url) throw new Error("Task query is missing its URL.");
  const params = url.searchParams;
  const profileId = params.get("profileId")?.trim();
  if (!profileId) throw new Error("profileId is required.");
  return { profileId, query: {
    projectId: params.get("projectId") ?? undefined,
    tasksetId: params.get("tasksetId") ?? undefined,
    draftId: params.get("draftId") ?? undefined,
    taskId: params.get("taskId") ?? undefined,
    query: params.get("query") ?? "",
    split: params.get("split") ?? undefined,
    after: params.get("after") ?? undefined,
    limit: Number(params.get("limit") ?? 30),
  } };
}

/** Index saved bytes once per source hash; requests only return bounded rows. */
export function createTaskInventoryService(store: SqliteStore, artifacts: ReturnType<typeof createDatasetArtifactService>) {
  const indexing = new Map<string, Promise<void>>();
  async function index(source: LocalTaskInventorySource) {
    if (await store.taskInventorySourceIndexed(source)) return;
    const key = JSON.stringify([source.profileId, source.id, source.draft, source.hash]);
    const running = indexing.get(key);
    if (running) return running;
    const work = (async () => {
      const document = source.draft ? await store.getTasksetDraft(source.id) : await store.getTaskset(source.id);
      if (!document || document.profileId !== source.profileId || document.revision !== source.revision) throw new Error("Task collection changed or is unavailable in this Profile.");
      if (document.datasetArtifact) {
        const registered = await store.getDatasetArtifactRegistryEntry(document.datasetArtifact.id);
        if (!registered || registered.profileId !== source.profileId || registered.manifest.contentHash !== document.datasetArtifact.contentHash) throw new Error("Dataset artifact is unavailable in this Profile.");
        let cursor: string | null = null;
        let offset = 0;
        do {
          const page = await artifacts.rows(document.datasetArtifact.tasksetId, { split: null, cursor, limit: 100, columns: [] });
          if (page.artifactHash !== document.datasetArtifact.contentHash) throw new Error("Dataset artifact differs from this task collection revision.");
          const tasks = page.rows.map(row => TaskDataRecordSchema.parse(row));
          await store.appendTaskInventoryRows(source, tasks, offset);
          offset += tasks.length;
          if (page.nextCursor === cursor && cursor !== null) throw new Error("Dataset task cursor did not advance.");
          cursor = page.nextCursor;
        } while (cursor);
      } else {
        for (let offset = 0; offset < document.tasks.length; offset += 100) {
          await store.appendTaskInventoryRows(source, document.tasks.slice(offset, offset + 100).map(task => TaskDataRecordSchema.parse(task)), offset);
        }
      }
      await store.finishTaskInventorySource(source, { tasksetName: document.name, scoring: summarizeTaskScoring(document.graders), configuration: taskConfiguration(document.graders) });
    })();
    indexing.set(key, work);
    try { await work; } finally { indexing.delete(key); }
  }
  async function sources(profileId: string, input: unknown) {
    const query = TaskInventoryQuerySchema.parse(input);
    const entries = await store.taskInventorySources(profileId, query.projectId);
    const selected = entries.filter(source => (!query.tasksetId || source.id === query.tasksetId) && (!query.draftId || source.draft && source.id === query.draftId));
    for (const source of selected) await index(source);
    return { query, entries };
  }
  return {
    async list(profileId: string, input: unknown) {
      const { query, entries } = await sources(profileId, input);
      return store.readTaskInventoryPage(profileId, query, entries);
    },
    async detail(profileId: string, input: unknown) {
      const { query, entries } = await sources(profileId, input);
      if (!query.tasksetId || !query.taskId) throw new Error("Choose a collection and task.");
      const page = await store.readTaskInventoryPage(profileId, { ...query, after: undefined, limit: 1 }, entries);
      const item = page.items[0];
      const source = entries.find(source => source.id === query.tasksetId && (source.draft ? source.id : null) === item?.draftId);
      if (!item || !source) throw new Error("Task not found in this Profile or Model.");
      const task = await store.readTaskInventoryTask(source, query.taskId);
      return { item, task };
    },
  };
}
