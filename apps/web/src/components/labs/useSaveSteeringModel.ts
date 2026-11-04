import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  SteeringModelSaveIntentSchema,
  SteeringModelSaveOptionsSchema,
  type SteeringModelSaveIntent,
} from "@openpond/contracts";
import {
  canonicalJson,
  ManagedModificationExecutionMetadataSchema,
  SteeringProfileSaveRequestSchema,
  parseAndVerifySteeringProfileReceipt,
  type ManagedModificationExecution,
  type SteeringProfileSaveRequest,
  type SteeringProfileReceipt,
} from "openpond-sdk/training";
import { apiFetch, ApiRequestError } from "../../api/api-client";
import { connectionQueryScope } from "../../lib/query-scope";
import { useManagedModificationClient } from "./workspace/managed-modification-api";
import type { WorkspaceApi } from "./workspace/workspace-api";

const ACTION = "training-steering-result-save";
type Attempt = {
  intent: SteeringModelSaveIntent;
  command: SteeringProfileSaveRequest;
  operation: Awaited<ReturnType<WorkspaceApi["operation"]>>;
};
function declined(error: unknown) {
  return (
    error instanceof ApiRequestError &&
    error.status === 409 &&
    error.retryable === false &&
    [
      "steering_profile_revision_conflict",
      "steering_model_revision_conflict",
      "steering_model_serving_in_use",
      "steering_model_base_mismatch",
      "steering_profile_result_changed",
      "steering_profile_result_unavailable",
    ].includes(error.code ?? "")
  );
}
/** A canonical result is the only fresh source. The existing device journal
 * retains immutable publication commands across result deletion or lost replies. */
export function useSaveSteeringModel(
  api: WorkspaceApi,
  id: string,
  execution?: ManagedModificationExecution,
) {
  const cache = useQueryClient(),
    identity = canonicalJson([api.key, connectionQueryScope(api.connection), id]);
  const live = useRef(identity);
  live.current = identity;
  useEffect(() => {
    live.current = identity;
    return () => {
      live.current = "";
    };
  }, [identity]);
  type Frame = {
    identity: string;
    busy: boolean;
    error: unknown;
    original: Attempt | null;
    receipt: SteeringProfileReceipt | null;
  };
  const empty = (): Frame => ({
    identity,
    busy: false,
    error: null,
    original: null,
    receipt: null,
  });
  const [frame, setFrame] = useState<Frame>(empty),
    active = useRef(new Set<string>());
  const state = frame.identity === identity ? frame : empty();
  function patch(value: Partial<Frame>) {
    if (live.current === identity)
      setFrame((current) => ({ ...(current.identity === identity ? current : empty()), ...value }));
  }
  function fence() {
    if (live.current !== identity)
      throw new Error("Return to this Model save's original account and result.");
  }
  const eligible =
    execution?.method === "neuron_steering" &&
    execution.phase === "completed" &&
    execution.result !== null;
  const context = useManagedModificationClient(api, eligible);
  const pending = useQuery({
    queryKey: ["steering-model-save-recovery", identity],
    enabled: Boolean(api.actorId) && !state.busy,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    queryFn: async ({ signal }) => {
      const found: Attempt[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      for (let n = 0; ; n++) {
        if (n >= 100)
          throw new Error("The retained Model save catalog exceeds its supported bound.");
        const page = await api.pendingOperations(ACTION, cursor, signal);
        for (const row of page.items) {
          const intent = SteeringModelSaveIntentSchema.parse(row.reviewedIntent);
          if (intent.request.executionId !== id) continue;
          if (
            intent.account.actorId !== api.actorId ||
            intent.account.teamId !== api.teamId ||
            intent.execution.projectId !== api.projectId
          )
            throw new Error("The retained Model save belongs to another creator or Project.");
          const command = SteeringProfileSaveRequestSchema.parse(
            row.command ?? { ...intent.request, operationId: row.id },
          );
          found.push({ intent, command, operation: api.recoverOperation(row) });
        }
        if (!page.nextCursor) break;
        if (seen.has(page.nextCursor))
          throw new Error("The retained Model save catalog repeated a cursor.");
        seen.add(page.nextCursor);
        cursor = page.nextCursor;
      }
      return found.sort((a, b) => a.operation.createdAt.localeCompare(b.operation.createdAt));
    },
  });
  const original = state.original ?? pending.data?.[0] ?? null;
  const options = useQuery({
    queryKey: [
      "steering-model-save-options",
      identity,
      context.data?.account.apiOrigin,
      execution?.result?.contentHash,
    ],
    enabled: eligible && context.isSuccess && pending.isSuccess && !original && !state.busy,
    retry: false,
    queryFn: async ({ signal }) => {
      if (!context.data) throw new Error("Read the configured result account first.");
      const account = context.data.account,
        params = new URLSearchParams({
          ...account,
          ...(api.projectId ? { projectId: api.projectId } : {}),
        });
      const value = SteeringModelSaveOptionsSchema.parse(
        await apiFetch(
          api.connection,
          `/v1/training/modification-executions/${encodeURIComponent(id)}/model?${params}`,
          { signal },
        ),
      );
      if (
        canonicalJson(value.account) !== canonicalJson(account) ||
        value.executionId !== id ||
        value.projectId !== api.projectId
      )
        throw new Error("The Model targets differ from this exact result account or Project.");
      return value;
    },
  });
  async function dispatch(attempt: Attempt) {
    patch({ original: attempt });
    await attempt.operation.retainCommand(attempt.command, "dispatching");
    fence();
    let receipt: SteeringProfileReceipt;
    try {
      const raw = await apiFetch(
        api.connection,
        `/v1/training/modification-executions/${encodeURIComponent(attempt.command.executionId)}/model`,
        {
          method: "POST",
          body: JSON.stringify({
            ...attempt.intent.account,
            projectId: attempt.intent.execution.projectId,
            intentHash: attempt.operation.intentHash,
            command: attempt.command,
          }),
        },
      );
      receipt = await parseAndVerifySteeringProfileReceipt(raw, attempt.command);
      fence();
      if (receipt.actorId !== api.actorId || receipt.record.publication.projectId !== api.projectId)
        throw new Error("The saved Model receipt belongs to another creator or Project.");
    } catch (error) {
      if (declined(error)) {
        await attempt.operation.acknowledge();
        fence();
        patch({ original: null });
        await pending.refetch();
        fence();
        void options.refetch();
      }
      throw error;
    }
    patch({ receipt });
    for (const name of [
      "saved-training-model",
      "saved-model-serving",
      "steering-model-save-options",
      "unified-experiments",
      "model-projects",
    ])
      void cache.invalidateQueries({ queryKey: [name] });
    await attempt.operation.acknowledge();
    fence();
    patch({ original: null });
    await pending.refetch();
    fence();
    return receipt;
  }
  async function save(value: { name: string; variantId: string; modelProjectId: string | null }) {
    if (active.current.has(identity)) return null;
    active.current.add(identity);
    patch({ busy: true, error: null });
    try {
      fence();
      if (!pending.isSuccess) throw new Error("Reload the original Model saves before continuing.");
      if (original) return await dispatch(original);
      if (
        !eligible ||
        !execution?.result ||
        !options.isSuccess ||
        !context.isSuccess ||
        !options.data
      )
        throw new Error(
          "Read the completed steering result and current Model targets before saving.",
        );
      const variant = execution.request.variants.find((row) => row.id === value.variantId);
      if (!variant?.profile)
        throw new Error(
          "Choose an exact saved profile variant; Off and inspection cannot be saved as a steering Model.",
        );
      const target = value.modelProjectId
        ? options.data.models.find((model) => model.id === value.modelProjectId)
        : null;
      if (value.modelProjectId && !target)
        throw new Error("Refresh the Model targets before updating this Model.");
      const {
        schemaVersion: _schema,
        request: _request,
        sourceForm: _form,
        result: _result,
        resultRecordedAt: _recorded,
        contentHash: _hash,
        ...metadata
      } = execution;
      const intent = SteeringModelSaveIntentSchema.parse({
        account: options.data.account,
        execution: ManagedModificationExecutionMetadataSchema.parse(metadata),
        request: {
          teamId: api.teamId,
          executionId: id,
          variantId: variant.id,
          resultHash: execution.result.contentHash,
          profileHash: variant.profile.contentHash,
          name: value.name,
          modelProjectId: target?.id ?? null,
          expectedModelRevision: target?.revision ?? 0,
        },
      });
      const operation = await api.operation(ACTION, intent);
      fence();
      return await dispatch({
        intent,
        operation,
        command: SteeringProfileSaveRequestSchema.parse({
          ...intent.request,
          operationId: operation.id,
        }),
      });
    } catch (error) {
      if (live.current === identity) patch({ error });
      return null;
    } finally {
      active.current.delete(identity);
      patch({ busy: false });
    }
  }
  return {
    save,
    busy: state.busy,
    receipt: state.receipt,
    original,
    options: options.data,
    freshReady: eligible && pending.isSuccess && options.isSuccess && context.isSuccess,
    recoveryReady: pending.isSuccess,
    error: state.error ?? pending.error ?? (eligible ? (options.error ?? context.error) : null),
    refresh: () => {
      void pending.refetch();
      if (eligible && !original) {
        void context.refetch();
        if (context.data) void options.refetch();
      }
    },
  };
}
