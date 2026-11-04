import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DecisionModelScoreIntentSchema, type DecisionModelScoreIntent } from "@openpond/contracts";
import { canonicalJson, DecisionModelScoreRequestSchema, parseAndVerifyDecisionModelScoreReceipt, type DecisionModelScoreRequest, type DecisionModelScoreReceipt } from "openpond-sdk/training";
import { apiFetch } from "../../api/api-client";
import { useManagedDecisionClient } from "./workspace/managed-decision-api";
import type { WorkspaceApi } from "./workspace/workspace-api";

const action = "training-decision-score";
type Attempt = {intent: DecisionModelScoreIntent; command: {modelProjectId: string; request: DecisionModelScoreRequest}; operation: Awaited<ReturnType<WorkspaceApi["operation"]>>};
export function useScoreDecisionModel(api: WorkspaceApi, modelProjectId: string) {
  const identity = canonicalJson([api.key, api.actorId, api.connection.serverUrl, modelProjectId]), live = useRef(identity), active = useRef(new Set<string>());
  live.current = identity;
  useEffect(() => {live.current = identity; return () => {live.current = "";};}, [identity]);
  const cache = useQueryClient(), context = useManagedDecisionClient(api);
  const [frame, setFrame] = useState({identity, busy: false, error: null as unknown, original: null as Attempt | null, receipt: null as DecisionModelScoreReceipt | null});
  const state = frame.identity === identity ? frame : {identity, busy: false, error: null, original: null, receipt: null};
  function patch(value: Partial<typeof state>) {if (live.current === identity) setFrame(current => ({...(current.identity === identity ? current : {identity, busy: false, error: null, original: null, receipt: null}), ...value}));}
  function fence() {if (live.current !== identity) throw new Error("Return to the original account and exact Decision Model before continuing.");}
  const pending = useQuery({queryKey: ["decision-score-recovery", identity], enabled: Boolean(api.actorId) && !state.busy, retry: false, staleTime: 0, gcTime: 0,
    queryFn: async ({signal}) => {
      const found: Attempt[] = [], seen = new Set<string>(); let cursor: string | undefined;
      for (let n = 0; ; n++) {
        if (n >= 100) throw new Error("The retained scoring catalog exceeds its supported bound.");
        const page = await api.pendingOperations(action, cursor, signal);
        for (const row of page.items) {
          const intent = DecisionModelScoreIntentSchema.parse(row.reviewedIntent);
          if (intent.modelProjectId !== modelProjectId) continue;
          if (intent.account.teamId !== api.teamId || intent.account.actorId !== api.actorId) throw new Error("The retained score belongs to another account.");
          const raw = row.command as {modelProjectId?: unknown; request?: unknown} | null;
          const request = DecisionModelScoreRequestSchema.parse(raw?.request ?? {...intent.request, requestId: row.id});
          if (raw && raw.modelProjectId !== modelProjectId || request.requestId !== row.id) throw new Error("The retained score differs from its original operation.");
          found.push({intent, command: {modelProjectId, request}, operation: api.recoverOperation(row)});
        }
        if (!page.nextCursor) break;
        if (seen.has(page.nextCursor)) throw new Error("The retained scoring catalog repeated a page.");
        seen.add(page.nextCursor); cursor = page.nextCursor;
      }
      return found.sort((a,b) => a.operation.createdAt.localeCompare(b.operation.createdAt))[0] ?? null;
    }});
  const original = state.original ?? pending.data ?? null;
  async function run(request?: Omit<DecisionModelScoreRequest, "requestId">) {
    if (active.current.has(identity)) return null;
    active.current.add(identity); patch({busy: true, error: null});
    try {
      fence(); let attempt = original;
      if (!attempt) {
        if (!request || !context.data || !pending.isSuccess) throw new Error("Load this Model's account and retained scoring operations first.");
        const intent = DecisionModelScoreIntentSchema.parse({account: context.data.account, modelProjectId, request});
        const operation = await api.operation(action, intent); fence();
        attempt = {intent, operation, command: {modelProjectId, request: DecisionModelScoreRequestSchema.parse({...request, requestId: operation.id})}};
      }
      patch({original: attempt});
      await attempt.operation.retainCommand(attempt.command, "dispatching"); fence();
      const receipt = await parseAndVerifyDecisionModelScoreReceipt(await apiFetch(api.connection, `/v1/training/saved-models/${encodeURIComponent(modelProjectId)}/decisions`, {method: "POST", body: JSON.stringify({...attempt.intent.account, projectId: api.projectId, intentHash: attempt.operation.intentHash, command: attempt.command.request})}), {modelProjectId, request: attempt.command.request, actorId: api.actorId!});
      fence(); patch({receipt}); await attempt.operation.acknowledge(); fence(); patch({original: null});
      await pending.refetch(); void cache.invalidateQueries({queryKey: ["saved-model-serving"]}); return receipt;
    } catch (error) {patch({error}); return null;} finally {active.current.delete(identity); patch({busy: false});}
  }
  return {run, original, receipt: state.receipt, busy: state.busy, error: state.error ?? pending.error ?? context.error, ready: Boolean(original) || pending.isSuccess && context.isSuccess, refresh: () => {void pending.refetch(); void context.refetch();}};
}
