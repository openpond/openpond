import { useState } from "react";
import {
  StoredDecisionResultReferenceSchema,
  type ManagedDecisionExecution,
} from "openpond-sdk/training";
import { ErrorToast } from "../../common/ErrorToast";
import { useChatContextSelection } from "../../../hooks/useChatContextSelection";
import { useManagedDecisionClient } from "./managed-decision-api";
import type { WorkspaceApi } from "./workspace-api";

/** Stages exact evidence for chat; selecting it sends no message or execution. */
export function DecisionResultChatContext({
  api,
  execution,
}: {
  api: WorkspaceApi;
  execution: ManagedDecisionExecution;
}) {
  const context = useChatContextSelection(api.connection, null),
    client = useManagedDecisionClient(api);
  const [error, setError] = useState<unknown>(null);
  const selected =
    context.selection?.decisionResult?.id === execution.id &&
    context.selection.decisionResult.result?.contentHash === execution.result?.contentHash;
  async function select() {
    setError(null);
    try {
      if (!client.data || execution.phase !== "completed" || !execution.result)
        throw new Error("Read the exact completed Decision result in its original account first.");
      const result = StoredDecisionResultReferenceSchema.parse({
        kind: "decision_result",
        mode: execution.mode,
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
        kind: "decision_result",
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
