import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { TrainingResultSaveCommandSchema, TrainingResultSaveIntentSchema, parseAndVerifyTrainingResultSave,
  type TrainingResult, type TrainingResultSaveReceipt } from "openpond-sdk/training";
import { apiFetch, ApiRequestError } from "../../api/api-client";
import { connectionQueryScope } from "../../lib/query-scope";
import type { WorkspaceApi } from "./workspace/workspace-api";

const ACTION = "training-result-save";
type Attempt = { command: ReturnType<typeof TrainingResultSaveCommandSchema.parse>; operation: Awaited<ReturnType<WorkspaceApi["operation"]>> };

/** The existing device operation journal owns reviewed commands across reopen.
 * A lost reply retries that command; refreshing a result never dispatches it. */
export function useSaveTrainingModel(api: WorkspaceApi, result: TrainingResult) {
  const queries = useQueryClient();
  const scope = JSON.stringify([api.key, connectionQueryScope(api.connection), result.job.id]);
  const activeScope = useRef(scope); activeScope.current = scope;
  const mounted = useRef(true), active = useRef(false);
  const attempt = useRef<Attempt | null>(null);
  const [retained, setRetained] = useState<Attempt | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null);
  const [receipt, setReceipt] = useState<TrainingResultSaveReceipt | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const current = () => mounted.current && activeScope.current === scope;
  const pending = useQuery({
    queryKey: ["training-model-save-recovery", scope],
    queryFn: async ({ signal }) => {
      let cursor: string | undefined;
      const matches = [];
      const seen = new Set<string>();
      for (let n = 0; ; n++) {
        if (n >= 100) throw new Error("The retained save catalog exceeds its supported bound.");
        const page = await api.pendingOperations(ACTION, cursor, signal);
        for (const row of page.items) {
          const intent = TrainingResultSaveIntentSchema.parse(row.reviewedIntent);
          if (intent.jobId !== result.job.id) continue;
          if (intent.teamId !== api.teamId) throw new Error("The retained Model save belongs to another workspace.");
          const { jobId, ...body } = intent;
          const command = row.command ? TrainingResultSaveCommandSchema.parse(row.command)
            : TrainingResultSaveCommandSchema.parse({ jobId, request: { ...body, operationId: row.id } });
          matches.push({ command, operation: api.recoverOperation(row) });
        }
        if (!page.nextCursor) break;
        if (seen.has(page.nextCursor)) throw new Error("The retained save catalog repeated a page.");
        seen.add(page.nextCursor); cursor = page.nextCursor;
      }
      if (matches.length > 1) throw new Error("More than one Model save is retained for this run. Resolve the original commands before creating another save.");
      return matches[0] ?? null;
    }, staleTime: 0, gcTime: 0, retry: false,
  });
  const original = retained ?? pending.data ?? null;
  async function save(name: string) {
    if (active.current || receipt || !pending.isSuccess) return null;
    active.current = true; setBusy(true); setError(null);
    let dispatching = false;
    try {
      if (!api.actorId) throw new Error("Choose an authenticated account before saving a Model.");
      if (!original && !name.trim()) throw new Error("Enter a Model name.");
      if (!attempt.current) {
        if (original) attempt.current = original;
        else {
          if (!result.model || !result.request || !result.candidate) throw new Error("Refresh the completed result before saving its Model.");
          const intent = TrainingResultSaveIntentSchema.parse({ schemaVersion: "openpond.trainingResultSave.v1", jobId: result.job.id,
            teamId: api.teamId, name, expectedModelRevision: result.model.revision, submissionHash: result.request.submissionHash,
            artifact: result.candidate.artifact, checkpointId: result.candidate.checkpointId });
          const operation = await api.operation(ACTION, intent);
          if (!current()) return null;
          const { jobId, ...body } = intent;
          attempt.current = { operation, command: TrainingResultSaveCommandSchema.parse({ jobId, request: { ...body, operationId: operation.id } }) };
        }
        setRetained(attempt.current);
      }
      const saved = attempt.current;
      await saved.operation.retainCommand(saved.command, "dispatching");
      if (!current()) return null;
      dispatching = true;
      const response = await parseAndVerifyTrainingResultSave(await apiFetch(api.connection,
        `/v1/training/hosted-jobs/${encodeURIComponent(saved.command.jobId)}/model?teamId=${encodeURIComponent(api.teamId)}`,
        { method: "POST", body: JSON.stringify(saved.command.request) }), { jobId: result.job.id, request: saved.command.request, actorId: api.actorId });
      if (!current()) return null;
      setReceipt(response);
      void queries.invalidateQueries({ queryKey: ["hosted-training-result"] });
      void queries.invalidateQueries({ queryKey: ["saved-training-model"] });
      try { await saved.operation.acknowledge(); }
      catch (reason) { if (current()) setError(reason); return { receipt: response, acknowledgementError: reason }; }
      return { receipt: response, acknowledgementError: null };
    } catch (reason) {
      if (current()) {
        setError(reason);
        // These explicit hosted denials did not commit a save. Preserve their
        // command in acknowledged history and allow refreshed settings.
        if (dispatching && reason instanceof ApiRequestError && [400, 403, 404, 409, 422].includes(reason.status) && attempt.current) {
          try {
            await attempt.current.operation.acknowledge();
            if (current()) { attempt.current = null; setRetained(null); await pending.refetch(); }
          } catch (ackError) { if (current()) setError(ackError); }
        }
      }
      return null;
    } finally { active.current = false; if (current()) setBusy(false); }
  }
  return { save, busy, receipt, retained: original, error: error ?? pending.error,
    recoveryReady: pending.isSuccess, refreshRecovery: pending.refetch };
}
