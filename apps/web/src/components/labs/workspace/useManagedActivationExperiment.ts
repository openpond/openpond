import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ActivationExperimentPrepareIntentSchema,
  ActivationExperimentControlIntentSchema,
  type ActivationExperimentPrepareIntent,
  type ActivationExperimentControlIntent,
} from "@openpond/contracts";
import {
  canonicalJson,
  canonicalComputeSpendCap,
  canonicalSha256,
  ManagedModificationExecutionMetadataSchema,
  parseAndVerifyManagedModificationPrepare,
  ManagedModificationPrepareSchema,
  parseManagedModificationControl,
  type ExperimentDraft,
  type ManagedModificationExecution,
  type ManagedModificationExecutionReceipt,
  type ManagedModificationPrepare,
  type ManagedModificationStart,
  type ManagedModificationCancel,
} from "openpond-sdk/training";
import { managedModificationApi, useManagedModificationClient } from "./managed-modification-api";
import { ApiRequestError } from "../../../api/api-client";
import { experimentDraftApi } from "./experiment-draft-api";
import type { WorkspaceApi } from "./workspace-api";

type Command = ManagedModificationPrepare | ManagedModificationStart | ManagedModificationCancel;
type Intent = ActivationExperimentPrepareIntent | ActivationExperimentControlIntent;
type Attempt = {
  intent: Intent;
  command: Command;
  operation: Awaited<ReturnType<WorkspaceApi["operation"]>>;
};
function definitive(error: unknown, command: Command) {
  if (!(error instanceof ApiRequestError) || error.status !== 409 || error.retryable !== false)
    return false;
  // These canonical owner refusals follow immutable receipt lookup. Ambiguous
  // authorization, deletion, integrity and transport outcomes remain retained.
  return (
    "action" in command
      ? [
          "modification_execution_revision_conflict",
          "modification_execution_review_required",
          "modification_execution_runtime_changed",
          "modification_execution_funding_changed",
          "modification_execution_project_archived",
          "modification_execution_cancel_unavailable",
        ]
      : [
          "modification_execution_runtime_unavailable",
          "modification_execution_runtime_limits",
          "modification_execution_capability_changed",
          "modification_execution_project_archived",
        ]
  ).includes(error.code ?? "");
}
const actions = [
  "training:prepare-modification",
  "training:start-modification",
  "training:cancel-modification",
] as const;
/** One ordinary experiment panel, canonical hosted execution and the existing
 * durable reviewed-operation journal. Reads never dispatch work. */
export function useManagedActivationExperiment(
  api: WorkspaceApi,
  input: {
    draftId: string | null;
    executionId?: string;
    method?: "neuron_steering" | "inspect_activations";
    visible: boolean;
  },
) {
  const cache = useQueryClient();
  const identity = canonicalJson([
    api.key,
    api.connection.serverUrl,
    input.draftId,
    input.executionId ?? null,
    input.method ?? null,
  ]);
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
    receipt: ManagedModificationExecutionReceipt | null;
    selected: string | null;
    original: Attempt | null;
    preparationOperationId: string | null;
  };
  const empty = (): Frame => ({
    identity,
    busy: false,
    error: null,
    receipt: null,
    selected: null,
    original: null,
    preparationOperationId: null,
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
      throw new Error("Return to this experiment's original account before continuing.");
  }
  const context = useManagedModificationClient(api, input.visible);
  const client = context.data;
  const pending = useQuery({
    queryKey: ["activation-experiment-recovery", identity],
    enabled: input.visible && api.location === "hosted" && Boolean(api.actorId) && !state.busy,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    queryFn: async ({ signal }) => {
      const found: Attempt[] = [];
      for (const action of actions) {
        let cursor: string | undefined;
        const seen = new Set<string>();
        for (let n = 0; ; n++) {
          if (n >= 100)
            throw new Error("The retained execution catalog exceeds its supported bound.");
          const page = await api.pendingOperations(action, cursor, signal);
          for (const row of page.items) {
            const intent =
              action === actions[0]
                ? ActivationExperimentPrepareIntentSchema.parse(row.reviewedIntent)
                : ActivationExperimentControlIntentSchema.parse(row.reviewedIntent);
            if (intent.account.actorId !== api.actorId || intent.account.teamId !== api.teamId)
              throw new Error("The retained execution belongs to another account.");
            const matching =
              input.draftId !== null
                ? intent.draftId === input.draftId
                : "execution" in intent && intent.execution.id === input.executionId;
            if (!matching) continue;
            const command =
              action === actions[0]
                ? ManagedModificationPrepareSchema.parse(
                    row.command ?? { ...intent.request, operationId: row.id },
                  )
                : parseManagedModificationControl(
                    row.command ?? { ...intent.request, operationId: row.id },
                  );
            found.push({ intent, command, operation: api.recoverOperation(row) });
          }
          if (!page.nextCursor) break;
          if (seen.has(page.nextCursor))
            throw new Error("The retained execution catalog repeated a cursor.");
          seen.add(page.nextCursor);
          cursor = page.nextCursor;
        }
      }
      return found.sort((a, b) => a.operation.createdAt.localeCompare(b.operation.createdAt));
    },
  });
  const original = state.original ?? pending.data?.[0] ?? null;
  const id =
    input.executionId ??
    state.selected ??
    state.receipt?.execution.id ??
    (original && "execution" in original.intent ? original.intent.execution.id : null);
  const read = useQuery({
    queryKey: ["managed-modification-execution", identity, id],
    enabled: input.visible && Boolean(client && id),
    retry: false,
    queryFn: ({ signal }) => {
      if (!client || !id) throw new Error("Select an execution first.");
      return client.get(id, signal);
    },
    refetchInterval: (query) =>
      query.state.error
        ? false
        : query.state.data && !["completed", "failed", "cancelled"].includes(query.state.data.phase)
          ? 3000
          : false,
  });
  async function dispatch(attempt: Attempt) {
    // Recovery uses the original journal pin through the local authenticated
    // relay. That relay compares its origin with the configured account before
    // any hosted I/O; this is never an arbitrary-origin fetch.
    const retainedClient = managedModificationApi(api, attempt.intent.account.apiOrigin);
    if (canonicalJson(retainedClient.account) !== canonicalJson(attempt.intent.account))
      throw new Error("Return to this execution's original account before retrying.");
    patch({ original: attempt });
    await attempt.operation.retainCommand(attempt.command, "dispatching");
    fence();
    let receipt: ManagedModificationExecutionReceipt;
    try {
      receipt = await retainedClient.mutate(attempt.command, attempt.operation.intentHash);
      fence();
    } catch (error) {
      if (definitive(error, attempt.command)) {
        await attempt.operation.acknowledge();
        fence();
        patch({ original: null });
        await pending.refetch();
        fence();
        void cache.invalidateQueries({ queryKey: ["managed-modification-execution"] });
      }
      throw error;
    }
    patch({
      receipt,
      selected: receipt.execution.id,
      preparationOperationId:
        "action" in attempt.command
          ? "preparationOperationId" in attempt.intent
            ? attempt.intent.preparationOperationId
            : null
          : attempt.command.operationId,
    });
    await attempt.operation.acknowledge();
    fence();
    patch({ original: null });
    await pending.refetch();
    fence();
    void cache.invalidateQueries({ queryKey: ["managed-modification-execution"] });
    void cache.invalidateQueries({ queryKey: ["unified-experiments"] });
    return receipt;
  }
  async function work(fn: () => Promise<unknown>) {
    if (active.current.has(identity)) return;
    active.current.add(identity);
    patch({ busy: true, error: null });
    try {
      fence();
      return await fn();
    } catch (error) {
      if (live.current === identity) patch({ error });
      return null;
    } finally {
      active.current.delete(identity);
      patch({ busy: false });
    }
  }
  async function prepare(
    draft: ExperimentDraft,
    save: (draft: ExperimentDraft) => Promise<unknown>,
  ) {
    return work(async () => {
      if (original) return dispatch(original);
      if (
        !client ||
        !pending.isSuccess ||
        !input.draftId ||
        draft.id !== input.draftId ||
        !draft.activationForm ||
        !input.method
      )
        throw new Error("Load this saved experiment and original requests before preparing.");
      const cap = canonicalComputeSpendCap(draft.activationForm.maximumSpendUsd);
      await save(draft);
      fence();
      const record = await experimentDraftApi(api).get(draft.id);
      fence();
      if (
        record.status !== "draft" ||
        record.projectId !== api.projectId ||
        canonicalJson(record.draft) !== canonicalJson(draft)
      )
        throw new Error(
          "The saved experiment changed. Reopen its exact current revision before preparing.",
        );
      const model = draft.activationForm.baseModel;
      if (!model || draft.startingModel?.source === "trained")
        throw new Error("Choose a qualified exact activation starting model.");
      const query = {
        teamId: api.teamId,
        modelId: model.modelId,
        source: model.source,
        ...(model.revision ? { revision: model.revision } : {}),
        ...(model.tokenizerRevision ? { tokenizerRevision: model.tokenizerRevision } : {}),
        ...(model.chatTemplateHash ? { chatTemplateHash: model.chatTemplateHash } : {}),
        ...(model.modelAssetId ? { modelAssetId: model.modelAssetId } : {}),
      };
      const compile = {
        teamId: api.teamId,
        projectId: api.projectId,
        method: input.method,
        query,
        form: draft.activationForm,
      };
      const compiled = await client.compile(compile);
      fence();
      if (
        compiled.actorId !== api.actorId ||
        compiled.formHash !== (await canonicalSha256(draft.activationForm))
      )
        throw new Error("The compilation differs from this exact saved form.");
      const parsed = await parseAndVerifyManagedModificationPrepare({
        teamId: api.teamId,
        projectId: api.projectId,
        operationId: crypto.randomUUID(),
        name: draft.name,
        method: input.method,
        query,
        request: compiled.request,
        sourceForm: draft.activationForm,
        maximumSpendUsd: cap,
      });
      const { operationId: _unused, ...request } = parsed;
      const intent = ActivationExperimentPrepareIntentSchema.parse({
        account: client.account,
        draftId: draft.id,
        request,
      });
      const operation = await api.operation(actions[0], intent);
      fence();
      return dispatch({ intent, operation, command: { ...parsed, operationId: operation.id } });
    });
  }
  async function control(action: "start" | "cancel", reviewed?: ManagedModificationExecution) {
    return work(async () => {
      if (original) return dispatch(original);
      const value = reviewed ?? read.data;
      if (!client || !pending.isSuccess || !value || read.error)
        throw new Error("Read the exact execution before reviewing its next action.");
      const {
        schemaVersion: _schema,
        request: _configuration,
        sourceForm: _form,
        result: _result,
        resultRecordedAt: _recorded,
        contentHash: _hash,
        ...projection
      } = value;
      const metadata = ManagedModificationExecutionMetadataSchema.parse(projection);
      const request =
        action === "start"
          ? {
              teamId: api.teamId,
              id: value.id,
              expectedRevision: value.revision,
              planHash: value.plan.contentHash,
              action,
              approvedMaximumSpendUsd: value.plan.maximumSpendUsd,
              ...(value.plan.computePrice
                ? { approvedPriceHash: await canonicalSha256(value.plan.computePrice) }
                : {}),
            }
          : {
              teamId: api.teamId,
              id: value.id,
              expectedRevision: value.revision,
              planHash: value.plan.contentHash,
              action,
            };
      const intent = ActivationExperimentControlIntentSchema.parse({
        account: client.account,
        draftId: state.preparationOperationId ? input.draftId : null,
        preparationOperationId: state.preparationOperationId,
        execution: metadata,
        request,
      });
      const operation = await api.operation(action === "start" ? actions[1] : actions[2], intent);
      fence();
      return dispatch({
        intent,
        operation,
        command: parseManagedModificationControl({ ...request, operationId: operation.id }),
      });
    });
  }
  return {
    prepare,
    control,
    retry: () =>
      work(() => {
        if (!original) throw new Error("Reload the original execution request.");
        return dispatch(original);
      }),
    busy: state.busy,
    receipt: state.receipt,
    original,
    execution: read.data,
    ready: context.isSuccess && pending.isSuccess,
    recoveryReady: pending.isSuccess,
    canControl: read.isSuccess && !read.error,
    error: state.error ?? context.error ?? pending.error ?? read.error,
    refresh: () => {
      void context.refetch();
      if (api.actorId) void pending.refetch();
      if (client && id) void read.refetch();
    },
    loading: read.isFetching || context.isFetching,
    selectedId: id,
  };
}
