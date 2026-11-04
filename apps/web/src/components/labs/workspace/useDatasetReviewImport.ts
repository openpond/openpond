import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  DatasetTrainingReviewRequestSchema,
  parseAndVerifyDatasetTrainingReviewReceipt,
  type DatasetTrainingReviewRequest,
  type DatasetTrainingReviewReceipt,
} from "openpond-sdk/training";
import { apiFetch } from "../../../api/api-client";
import { connectionQueryScope, learningQueryScope } from "../../../lib/query-scope";
import type { OpenPondLearningClient } from "openpond-sdk/learning";
import type { WorkspaceApi } from "./workspace-api";

export function useDatasetReviewImport(api: WorkspaceApi, client: OpenPondLearningClient, beforeImport?: () => Promise<void>) {
  const queries = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [receipt, setReceipt] = useState<DatasetTrainingReviewReceipt | null>(null);
  const active = useRef(false);
  const mounted = useRef(true);
  const scope = `${api.key}:${connectionQueryScope(api.connection)}`;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const retained = useRef<{
    scope: string;
    request: DatasetTrainingReviewRequest;
    operation: Awaited<ReturnType<WorkspaceApi["operation"]>>;
  } | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const current = () => mounted.current && currentScope.current === scope;
  async function submit(makeIntent: () => Omit<DatasetTrainingReviewRequest, "operationId">) {
    if (active.current || receipt) return;
    active.current = true;
    setBusy(true);
    setError(null);
    try {
      if (!api.actorId)
        throw new Error("Choose an authenticated account before importing examples.");
      if (!retained.current) {
        const { operationId: _unused, ...intent } = DatasetTrainingReviewRequestSchema.parse({
          ...makeIntent(),
          operationId: "reviewed-import",
        });
        await beforeImport?.();
        if (!current()) return;
        const operation = await api.operation("training:review-dataset", intent);
        if (!current()) return;
        retained.current = {
          scope,
          operation,
          request: DatasetTrainingReviewRequestSchema.parse({
            ...intent,
            operationId: operation.id,
          }),
        };
        setAttempted(true);
      }
      const pending = retained.current;
      if (!current() || pending.scope !== scope)
        throw new Error("The import account changed. Reopen Dataset review.");
      const result = await parseAndVerifyDatasetTrainingReviewReceipt(
        await apiFetch(
          api.connection,
          `/v1/training/setup/review-dataset?teamId=${encodeURIComponent(api.teamId)}`,
          {
            method: "POST",
            body: JSON.stringify(pending.request),
          },
        ),
        pending.request,
        api.actorId,
      );
      if (!current()) return;
      // A verified import remains successful if a later refresh/acknowledgment
      // fails. Never send another mutation merely to refresh the review inbox.
      setReceipt(result);
      void queries.invalidateQueries({ queryKey: learningQueryScope(client) });
      try {
        await pending.operation.acknowledge();
      } catch (error) {
        if (current()) setError(error);
      }
    } catch (error) {
      if (current()) setError(error);
    } finally {
      active.current = false;
      if (current()) setBusy(false);
    }
  }
  function editSettings() {
    if (active.current || receipt) return;
    // The original operation stays in the canonical recovery store. Reusing
    // identical settings reconciles that operation; changed intent gets a new ID.
    retained.current = null;
    setAttempted(false);
    setError(null);
  }
  return { busy, attempted, error, receipt, submit, editSettings };
}
