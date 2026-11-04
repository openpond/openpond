import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlphaEditExperimentPrepareIntentSchema,
  AlphaEditExperimentControlIntentSchema,
  type AlphaEditExperimentPrepareIntent,
  type AlphaEditExperimentControlIntent,
} from "@openpond/contracts";
import {
  canonicalJson,
  canonicalComputeSpendCap,
  canonicalSha256,
  ManagedAlphaEditExecutionMetadataSchema,
  parseAndVerifyManagedAlphaEditPrepare,
  ManagedAlphaEditPrepareSchema,
  parseManagedModificationControl,
  type ExperimentDraft,
  type ManagedAlphaEditExecution,
  type ManagedAlphaEditExecutionReceipt,
  type ManagedAlphaEditPrepare,
  type ManagedAlphaEditStart,
  type ManagedAlphaEditCancel,
} from "openpond-sdk/training";
import { managedAlphaEditApi, useManagedAlphaEditClient } from "./managed-alphaedit-api";
import { experimentDraftApi } from "./experiment-draft-api";
import type { WorkspaceApi } from "./workspace-api";

type Command = ManagedAlphaEditPrepare | ManagedAlphaEditStart | ManagedAlphaEditCancel;
type Intent = AlphaEditExperimentPrepareIntent | AlphaEditExperimentControlIntent;
type Attempt = {
  intent: Intent;
  command: Command;
  operation: Awaited<ReturnType<WorkspaceApi["operation"]>>;
};
const actions = [
  "training:prepare-alphaedit",
  "training:start-alphaedit",
  "training:cancel-alphaedit",
] as const;
/** One ordinary experiment panel, canonical hosted execution and the existing
 * durable reviewed-operation journal. Reads never dispatch work. */
export function useManagedAlphaEditExperiment(
  api: WorkspaceApi,
  input: {
    draftId: string | null;
    executionId?: string;
    method?: "alphaedit";
    visible: boolean;
  },
) {
  const cache = useQueryClient();
  const identity = canonicalJson([
    api.key,
    api.accountKey,
    api.actorId,
    api.teamId,
    api.projectId,
    api.connection.serverUrl,
    input.draftId,
    input.executionId,
    input.method,
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
    receipt: ManagedAlphaEditExecutionReceipt | null;
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
  const context = useManagedAlphaEditClient(api, input.visible);
  const client = context.data;
  const pending = useQuery({
    queryKey: ["alphaedit-experiment-recovery", identity],
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
                ? AlphaEditExperimentPrepareIntentSchema.parse(row.reviewedIntent)
                : AlphaEditExperimentControlIntentSchema.parse(row.reviewedIntent);
            if (intent.account.actorId !== api.actorId || intent.account.teamId !== api.teamId)
              throw new Error("The retained execution belongs to another account.");
            const matching =
              input.draftId !== null
                ? intent.draftId === input.draftId
                : "execution" in intent && intent.execution.id === input.executionId;
            if (!matching) continue;
            const command =
              action === actions[0]
                ? ManagedAlphaEditPrepareSchema.parse(
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
    queryKey: ["managed-alphaedit-execution", identity, id],
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
    const retainedClient = managedAlphaEditApi(api, attempt.intent.account.apiOrigin);
    if (canonicalJson(retainedClient.account) !== canonicalJson(attempt.intent.account))
      throw new Error("Return to this execution's original account before retrying.");
    patch({ original: attempt });
    await attempt.operation.retainCommand(attempt.command, "dispatching");
    fence();
    // No new owner-specific refusal is assumed definitive. Preserve the original
    // command across authorization, transport and uncertain response outcomes.
    const receipt = await retainedClient.mutate(attempt.command, attempt.operation.intentHash);
    fence();
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
    void cache.invalidateQueries({ queryKey: ["managed-alphaedit-execution"] });
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
        !draft.alphaEditForm ||
        !input.method
      )
        throw new Error("Load this saved experiment and original requests before preparing.");
      const cap = canonicalComputeSpendCap(draft.alphaEditForm.maximumSpendUsd);
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
      const model = draft.alphaEditForm.baseModel;
      if (
        !model ||
        model.source !== "managed" ||
        (draft.startingModel && !["managed", "alphaedit"].includes(draft.startingModel.source))
      )
        throw new Error("Choose a qualified exact AlphaEdit starting model.");
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
        form: draft.alphaEditForm,
      };
      const compiled = await client.compile(compile);
      fence();
      if (
        compiled.actorId !== api.actorId ||
        compiled.formHash !== (await canonicalSha256(draft.alphaEditForm))
      )
        throw new Error("The compilation differs from this exact saved form.");
      const parsed = await parseAndVerifyManagedAlphaEditPrepare({
        teamId: api.teamId,
        projectId: api.projectId,
        operationId: crypto.randomUUID(),
        name: draft.name,
        method: input.method,
        query,
        request: compiled.request,
        sourceForm: draft.alphaEditForm,
        maximumSpendUsd: cap,
      });
      const { operationId: _unused, ...request } = parsed;
      const intent = AlphaEditExperimentPrepareIntentSchema.parse({
        account: client.account,
        draftId: draft.id,
        request,
      });
      const operation = await api.operation(actions[0], intent);
      fence();
      return dispatch({ intent, operation, command: { ...parsed, operationId: operation.id } });
    });
  }
  async function control(action: "start" | "cancel", reviewed?: ManagedAlphaEditExecution) {
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
      const metadata = ManagedAlphaEditExecutionMetadataSchema.parse(projection);
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
      const intent = AlphaEditExperimentControlIntentSchema.parse({
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
    recoveryReady: Boolean(original) || pending.isSuccess,
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
