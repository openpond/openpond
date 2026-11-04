import { useState } from "react";
import {
  StoredAlphaEditResultReferenceSchema,
  type ManagedAlphaEditExecution,
} from "openpond-sdk/training";
import { ErrorToast } from "../../common/ErrorToast";
import { useChatContextSelection } from "../../../hooks/useChatContextSelection";
import { useManagedAlphaEditClient } from "./managed-alphaedit-api";
import type { WorkspaceApi } from "./workspace-api";

/** Stages exact evidence for chat; selecting it sends no message or execution. */
export function AlphaEditResultChatContext({
  api,
  execution,
}: {
  api: WorkspaceApi;
  execution: ManagedAlphaEditExecution;
}) {
  const context = useChatContextSelection(api.connection, null),
    client = useManagedAlphaEditClient(api);
  const [error, setError] = useState<unknown>(null);
  const selected =
    context.selection?.alphaEditResult?.id === execution.id &&
    context.selection.alphaEditResult.result?.contentHash === execution.result?.contentHash;
  async function select() {
    setError(null);
    try {
      if (!client.data || execution.phase !== "completed" || !execution.result)
        throw new Error("Read the exact completed AlphaEdit result in its original account first.");
      const result = StoredAlphaEditResultReferenceSchema.parse({
        kind: "alphaedit_result",
        location: "cloud",
        owner: { teamId: execution.teamId, actorId: execution.ownerUserId },
        apiOrigin: client.data.account.apiOrigin,
        projectId: execution.projectId,
        executionId: execution.id,
        inputHash: execution.plan.inputHash,
        modelHash: execution.result.modelHash,
        runtimeHash: execution.plan.runtimeHash,
        resultHash: execution.result.contentHash,
        artifact: execution.result.artifact
          ? { id: execution.result.artifact.id, contentHash: execution.result.artifact.contentHash }
          : null,
      });
      await context.select({
        kind: "alphaedit_result",
        id: execution.id,
        location: "cloud",
        teamId: api.teamId,
        apiOrigin: client.data.account.apiOrigin,
        result,
      });
    } catch (cause) {
      setError(cause);
    }
  }
  return (
    <>
      <ErrorToast error={error ?? client.error} />
      <button
        type="button"
        className="training-button secondary"
        disabled={context.selecting || !client.isSuccess}
        onClick={() => void select()}
      >
        {selected ? "Result selected for chat" : "Use result in chat"}
      </button>
    </>
  );
}
