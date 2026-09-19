import { useQuery } from "@tanstack/react-query";
import type { ModelProject } from "@openpond/contracts";
import type { ClientConnection } from "../../api";
import { createHostedModelLearningApi } from "../../api/model-learning-api";
import { connectionQueryScope } from "../../lib/query-scope";
import { Boxes } from "../icons";
import { useLearningClient } from "./learning/useLearningResources";

export function PendingTrainingTasksIcon({ connection, profileId, modelId, models }: { connection: ClientConnection | null; profileId: string | null; modelId: string | null; models: ModelProject[] }) {
  const client = useLearningClient(connection, profileId ?? "");
  const selected = models.find(model => model.id === modelId);
  const hosted = [...new Map(models.filter(model => model.profileId === profileId && model.hosted && (!modelId || model.id === modelId)).map(model => [JSON.stringify([model.hosted!.apiOrigin, model.hosted!.teamId]), model])).values()];
  const query = useQuery({ queryKey: ["pending-training-tasks", connectionQueryScope(connection), profileId, modelId, hosted.map(model => [model.id, model.hosted?.projectId, model.hosted?.apiOrigin, model.hosted?.teamId])], enabled: Boolean(client && connection && profileId), refetchInterval: 30_000,
    queryFn: async ({ signal }) => {
      const local = selected?.hosted ? [] : [await client!.inspectTaskQueue(modelId, { signal })];
      const remote = await Promise.all(hosted.map(model => createHostedModelLearningApi(connection!, model.id, model.profileId).taskQueue(!modelId)));
      const queues = [...local, ...remote];
      if (queues.some(queue => queue.pendingTrainingCount === null || queue.issues.length)) return null;
      return queues.reduce((count, queue) => count + queue.pendingTrainingCount!, 0);
    },
  });
  return <span className="pending-training-tasks-icon" title={query.error || query.data === null ? "Pending training count is unavailable. Check learning settings." : undefined}><Boxes size={16} />{typeof query.data === "number" ? <span className="pending-training-tasks-badge" aria-label={`${query.data} tasks pending training`}>{query.data > 999 ? "999+" : query.data}</span> : null}</span>;
}
