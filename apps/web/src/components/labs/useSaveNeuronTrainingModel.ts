import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  NeuronTrainingModelSaveIntentSchema,
  NeuronTrainingModelSaveOptionsSchema,
  type NeuronTrainingModelSaveIntent,
} from "@openpond/contracts";
import {
  canonicalJson,
  ManagedNeuronTrainingExecutionMetadataSchema,
  NeuronTrainingResultSaveRequestSchema,
  parseAndVerifyNeuronTrainingResultSaveReceipt,
  type ManagedNeuronTrainingExecution,
  type NeuronTrainingResultSaveRequest,
  type NeuronTrainingResultSaveReceipt,
} from "openpond-sdk/training";
import { apiFetch } from "../../api/api-client";
import { connectionQueryScope } from "../../lib/query-scope";
import { useManagedNeuronTrainingClient } from "./workspace/managed-neuron-training-api";
import type { WorkspaceApi } from "./workspace/workspace-api";

const ACTION = "training-neuron-training-result-save";
type Attempt = {
  intent: NeuronTrainingModelSaveIntent;
  command: NeuronTrainingResultSaveRequest;
  operation: Awaited<ReturnType<WorkspaceApi["operation"]>>;
};
/** A canonical result is the only fresh source. The existing device journal
 * retains immutable publication commands across result deletion or lost replies. */
export function useSaveNeuronTrainingModel(
  api: WorkspaceApi,
  id: string,
  execution?: ManagedNeuronTrainingExecution,
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
    receipt: NeuronTrainingResultSaveReceipt | null;
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
    execution?.method === "selective_neuron_training" &&
    execution.phase === "completed" &&
    execution.result !== null;
  const context = useManagedNeuronTrainingClient(api, eligible);
  const pending = useQuery({
    queryKey: ["neuron-training-model-save-recovery", identity],
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
          const intent = NeuronTrainingModelSaveIntentSchema.parse(row.reviewedIntent);
          if (intent.request.executionId !== id) continue;
          if (
            intent.account.actorId !== api.actorId ||
            intent.account.teamId !== api.teamId ||
            intent.execution.projectId !== api.projectId
          )
            throw new Error("The retained Model save belongs to another creator or Project.");
          const command = NeuronTrainingResultSaveRequestSchema.parse(
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
      "neuron-training-model-save-options",
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
      const value = NeuronTrainingModelSaveOptionsSchema.parse(
        await apiFetch(
          api.connection,
          `/v1/training/neuron-training-executions/${encodeURIComponent(id)}/model?${params}`,
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
    const raw = await apiFetch(
      api.connection,
      `/v1/training/neuron-training-executions/${encodeURIComponent(attempt.command.executionId)}/model`,
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
    const receipt = await parseAndVerifyNeuronTrainingResultSaveReceipt(raw, attempt.command);
    fence();
    if (receipt.actorId !== api.actorId || receipt.version.source.executionId !== id)
      throw new Error("The saved Model receipt belongs to another creator or Project.");
    patch({ receipt });
    for (const name of [
      "saved-training-model",
      "saved-model-serving",
      "neuron-training-model-save-options",
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
  async function save(value: { name: string; modelProjectId: string | null }) {
    if (active.current.has(identity)) return null;
    active.current.add(identity);
    patch({ busy: true, error: null });
    try {
      fence();
      if (original) return await dispatch(original);
      if (!pending.isSuccess) throw new Error("Reload the original Model saves before continuing.");
      if (
        !eligible ||
        !execution?.result ||
        !options.isSuccess ||
        !context.isSuccess ||
        !options.data
      )
        throw new Error(
          "Read the completed NeuronTraining result and current Model targets before saving.",
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
      const intent = NeuronTrainingModelSaveIntentSchema.parse({
        account: options.data.account,
        execution: ManagedNeuronTrainingExecutionMetadataSchema.parse(metadata),
        request: {
          teamId: api.teamId,
          executionId: id,
          resultHash: execution.result.contentHash,
          artifactHash: execution.result.artifact.contentHash,
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
        command: NeuronTrainingResultSaveRequestSchema.parse({
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
    recoveryReady: Boolean(original) || pending.isSuccess,
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
