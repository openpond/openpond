import { useContext, useMemo } from "react";
import type { ChatTrainingAttachment } from "@openpond/contracts";
import type { ClientConnection } from "../../api";
import { ChatContextAccountScope } from "../../hooks/useChatContextSelection";
import { TrainingResultDetails } from "../labs/TrainingResultDetails";
import { createWorkspaceApi } from "../labs/workspace/workspace-api";

/** The Job reference remains the conversation pin. Results and save recovery
 * use the same bounded owner as the run page, without a new execution. */
export function ChatHostedTrainingResult({ connection, training }: {
  connection: ClientConnection; training: Extract<ChatTrainingAttachment, { location: "cloud" }>;
}) {
  const accountKey = useContext(ChatContextAccountScope);
  const { teamId, actorId } = training.owner;
  const api = useMemo(() => createWorkspaceApi(connection, { teamId, actorId, accountKey, projectId: null }),
    [connection, teamId, actorId, accountKey]);
  return <TrainingResultDetails key={`${api.key}:${training.apiOrigin}:${training.jobId}`} connection={connection}
    teamId={teamId} actorId={actorId} jobId={training.jobId} version={training.job.version} api={api} />;
}
