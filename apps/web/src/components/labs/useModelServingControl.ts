import { WeightSpaceModelServingControlCommandSchema, WeightSpaceModelServingControlIntentSchema, parseAndVerifyWeightSpaceModelServingControl, type WeightSpaceModelServingControlReceipt } from "openpond-sdk/training";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  AlphaEditModelServingControlCommandSchema,
  AlphaEditModelServingControlIntentSchema,
  parseAndVerifyAlphaEditModelServingControl,
  type AlphaEditModelServingControlReceipt,
  NeuronTrainingModelServingControlCommandSchema,
  NeuronTrainingModelServingControlIntentSchema,
  parseAndVerifyNeuronTrainingModelServingControl,
  type NeuronTrainingModelServingControlReceipt,
  DecisionModelServingControlCommandSchema,
  DecisionModelServingControlIntentSchema,
  parseAndVerifyDecisionModelServingControl,
  type DecisionModelServingControlReceipt,
  EngramModelServingControlCommandSchema,
  EngramModelServingControlIntentSchema,
  parseAndVerifyEngramModelServingControl,
  type EngramModelServingControlReceipt,
  createServerlessServingApproval,
  TrainingModelServingControlCommandSchema,
  TrainingModelServingControlIntentSchema,
  SteeringModelServingControlCommandSchema,
  SteeringModelServingControlIntentSchema,
  parseAndVerifyTrainingModelServingControl,
  parseAndVerifySteeringModelServingControl,
  type SavedModelServing,
  type SteeringPublicationReference,
  type TrainingModelServingControlReceipt,
  type SteeringModelServingControlReceipt,
} from "openpond-sdk/training";
import { apiFetch, ApiRequestError } from "../../api/api-client";
import { connectionQueryScope } from "../../lib/query-scope";
import type { WorkspaceApi } from "./workspace/workspace-api";

const ACTION = "training-model-serving-control";
const Intent = z.union([
  AlphaEditModelServingControlIntentSchema,
  NeuronTrainingModelServingControlIntentSchema,
  WeightSpaceModelServingControlIntentSchema,
  DecisionModelServingControlIntentSchema,
  EngramModelServingControlIntentSchema,
  TrainingModelServingControlIntentSchema,
  SteeringModelServingControlIntentSchema,
]);
const Command = z.union([
  AlphaEditModelServingControlCommandSchema,
  NeuronTrainingModelServingControlCommandSchema,
  WeightSpaceModelServingControlCommandSchema,
  DecisionModelServingControlCommandSchema,
  EngramModelServingControlCommandSchema,
  TrainingModelServingControlCommandSchema,
  SteeringModelServingControlCommandSchema,
]);
type Attempt = {
  command: z.infer<typeof Command>;
  operation: Awaited<ReturnType<WorkspaceApi["operation"]>>;
};
type Receipt =
  | AlphaEditModelServingControlReceipt
  | NeuronTrainingModelServingControlReceipt
  | WeightSpaceModelServingControlReceipt
  | DecisionModelServingControlReceipt
  | TrainingModelServingControlReceipt
  | SteeringModelServingControlReceipt
  | EngramModelServingControlReceipt;
async function verifyReceipt(
  raw: unknown,
  command: Attempt["command"],
  actorId: string,
): Promise<Receipt> {
  const request = command.request;
  return request.schemaVersion === "openpond.alphaEditModelServingControlRequest.v1"
    ? parseAndVerifyAlphaEditModelServingControl(raw, {
        modelProjectId: command.modelProjectId,
        request,
        actorId,
      })
    : request.schemaVersion === "openpond.weightSpaceModelServingControlRequest.v1"
      ? parseAndVerifyWeightSpaceModelServingControl(raw,{modelProjectId:command.modelProjectId,request,actorId})
    : request.schemaVersion === "openpond.neuronTrainingModelServingControlRequest.v1"
      ? parseAndVerifyNeuronTrainingModelServingControl(raw, {
          modelProjectId: command.modelProjectId,
          request,
          actorId,
        })
      : request.schemaVersion === "openpond.decisionModelServingControlRequest.v1"
        ? parseAndVerifyDecisionModelServingControl(raw, {
            modelProjectId: command.modelProjectId,
            request,
            actorId,
          })
        : request.schemaVersion === "openpond.engramModelServingControlRequest.v1"
          ? parseAndVerifyEngramModelServingControl(raw, {
              modelProjectId: command.modelProjectId,
              request,
              actorId,
            })
          : request.schemaVersion === "openpond.steeringModelServingControlRequest.v1"
            ? parseAndVerifySteeringModelServingControl(raw, {
                modelProjectId: command.modelProjectId,
                request,
                actorId,
              })
            : parseAndVerifyTrainingModelServingControl(raw, {
                modelProjectId: command.modelProjectId,
                request,
                actorId,
              });
}
async function freshIntent(
  api: WorkspaceApi,
  modelProjectId: string,
  value: SavedModelServing,
  action: "activate" | "stop",
  idleTimeoutSeconds: number,
  defaultPublication: SteeringPublicationReference | null,
  defaultEnabled: boolean,
  spendingLimit?: string | null,
) {
  if (
    value.schemaVersion === "openpond.alphaEditModelServing.v1" ||
    (value.schemaVersion === "openpond.neuronTrainingModelServing.v1" || value.schemaVersion === "openpond.weightSpaceModelServing.v1")
  )
    return Intent.parse({
      schemaVersion:
        value.schemaVersion === "openpond.alphaEditModelServing.v1"
          ? "openpond.alphaEditModelServingControlRequest.v1"
          : value.schemaVersion === "openpond.weightSpaceModelServing.v1" ? "openpond.weightSpaceModelServingControlRequest.v1" : "openpond.neuronTrainingModelServingControlRequest.v1",
      teamId: api.teamId,
      modelProjectId,
      expectedRevision: value.control?.revision ?? 0,
      versionHash: value.version.contentHash,
      action,
      idleTimeoutSeconds,
    });
  if (value.schemaVersion === "openpond.decisionModelServing.v1")
    return Intent.parse({
      schemaVersion: "openpond.decisionModelServingControlRequest.v1",
      teamId: api.teamId,
      modelProjectId,
      expectedRevision: value.control?.revision ?? 0,
      versionHash: value.version.contentHash,
      action,
      idleTimeoutSeconds,
    });
  if (value.schemaVersion === "openpond.engramModelServing.v1")
    return Intent.parse({
      schemaVersion: "openpond.engramModelServingControlRequest.v1",
      teamId: api.teamId,
      modelProjectId,
      expectedRevision: value.control?.revision ?? 0,
      versionHash: value.version.contentHash,
      action,
      defaultEnabled: action === "stop" ? value.control?.defaultEnabled : defaultEnabled,
      idleTimeoutSeconds,
    });
  if (value.schemaVersion === "openpond.steeringModelServing.v1") {
    return Intent.parse({
      schemaVersion: "openpond.steeringModelServingControlRequest.v1",
      teamId: api.teamId,
      modelProjectId,
      expectedRevision: value.control?.revision ?? 0,
      versionHash: value.version.contentHash,
      action,
      defaultPublication:
        action === "stop" ? value.control?.defaultPublication : defaultPublication,
      idleTimeoutSeconds,
    });
  }
  return Intent.parse({
    schemaVersion: "openpond.trainingModelServingControlRequest.v1",
    ...(action === "activate" ? {serverlessApproval: await createServerlessServingApproval(
      value.serverlessReview ?? (() => { throw new Error("Refresh this Model's serverless price before activation."); })(), spendingLimit)} : {}),
    teamId: api.teamId,
    modelProjectId,
    expectedRevision: value.control?.revision ?? 0,
    artifact: action === "stop" ? value.control?.artifact : value.registry?.artifact,
    versionHash: action === "stop" ? value.control?.versionHash : value.version.contentHash,
    action,
    idleTimeoutSeconds,
  });
}
function definitive(error: unknown, attempt: Attempt) {
  if (!(error instanceof ApiRequestError) || error.status !== 409 || error.retryable !== false)
    return false;
  if (
    attempt.command.request.schemaVersion === "openpond.alphaEditModelServingControlRequest.v1" ||
    attempt.command.request.schemaVersion ===
      "openpond.neuronTrainingModelServingControlRequest.v1" ||
    attempt.command.request.schemaVersion === "openpond.weightSpaceModelServingControlRequest.v1" ||
    attempt.command.request.schemaVersion === "openpond.decisionModelServingControlRequest.v1"
  )
    return false;
  // The Engram owner reconciles its immutable receipt before these atomic
  // fresh-intent refusals. Other failures retain the original approval.
  if (attempt.command.request.schemaVersion === "openpond.engramModelServingControlRequest.v1")
    return [
      "engram_serving_revision_conflict",
      "engram_serving_runtime_unavailable",
      "engram_serving_cleanup_pending",
      "engram_serving_other_kind_active",
      "engram_serving_version_changed",
      "engram_serving_stop_required",
      "engram_serving_stop_changed",
    ].includes(error.code ?? "");
  return (
    attempt.command.request.schemaVersion === "openpond.steeringModelServingControlRequest.v1"
      ? [
          "steering_serving_revision_conflict",
          "steering_serving_cleanup_pending",
          "steering_serving_other_kind_active",
          "steering_serving_version_changed",
          "steering_serving_default_changed",
          "steering_serving_runtime_unavailable",
          "steering_serving_stop_required",
          "steering_serving_stop_changed",
        ]
      : [
          "model_serving_revision_conflict",
          "model_serving_runtime_unavailable",
          "model_serving_cleanup_pending",
          "model_serving_version_changed",
          "model_serving_candidate_not_qualified",
          "model_serving_stop_changed",
        ]
  ).includes(error.code ?? "");
}
/** The device journal owns the exact approval across reopen. Mutable serving
 * reads never replace or clear an unknown original operation. */
export function useModelServingControl(
  api: WorkspaceApi,
  modelProjectId: string,
  value?: SavedModelServing,
) {
  const queries = useQueryClient(),
    scope = JSON.stringify([api.key, connectionQueryScope(api.connection), modelProjectId]);
  const live = useRef(scope);
  live.current = scope;
  const mounted = useRef(true),
    active = useRef(new Set<string>());
  type Frame = {
    scope: string;
    retained: Attempt | null;
    busy: boolean;
    error: unknown;
    receipt: Receipt | null;
  };
  const empty = (): Frame => ({ scope, retained: null, busy: false, error: null, receipt: null });
  const [frame, setFrame] = useState<Frame>(empty);
  const state = frame.scope === scope ? frame : empty();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const current = () => mounted.current && live.current === scope;
  function patch(change: Partial<Frame>) {
    if (current())
      setFrame((previous) => ({ ...(previous.scope === scope ? previous : empty()), ...change }));
  }
  const pending = useQuery({
    queryKey: ["model-serving-control-recovery", scope],
    retry: false,
    staleTime: 0,
    gcTime: 0,
    queryFn: async ({ signal }) => {
      let cursor: string | undefined;
      const found: Attempt[] = [],
        seen = new Set<string>();
      for (let n = 0; ; n++) {
        if (n >= 100) throw new Error("The retained serving catalog exceeds its supported bound.");
        const page = await api.pendingOperations(ACTION, cursor, signal);
        for (const row of page.items) {
          const intent = Intent.parse(row.reviewedIntent);
          if (intent.modelProjectId !== modelProjectId) continue;
          if (intent.teamId !== api.teamId)
            throw new Error("The retained serving command belongs to another workspace.");
          const { modelProjectId: retainedModelId, ...body } = intent;
          found.push({
            command: Command.parse(
              row.command ?? {
                modelProjectId: retainedModelId,
                request: { ...body, operationId: row.id },
              },
            ),
            operation: api.recoverOperation(row),
          });
        }
        if (!page.nextCursor) break;
        if (seen.has(page.nextCursor))
          throw new Error("The retained serving catalog repeated a page.");
        seen.add(page.nextCursor);
        cursor = page.nextCursor;
      }
      if (found.length > 1)
        throw new Error(
          "Resolve the original retained serving commands before reviewing another action.",
        );
      return found[0] ?? null;
    },
  });
  const original = state.retained ?? pending.data ?? null;
  async function run(
    action: "activate" | "stop",
    idleTimeoutSeconds: number,
    defaultPublication: SteeringPublicationReference | null = null,
    defaultEnabled = true,
    spendingLimit?: string | null,
  ) {
    if (active.current.has(scope) || (!original && !pending.isSuccess)) return null;
    active.current.add(scope);
    patch({ busy: true, error: null });
    let dispatched: Attempt | null = null;
    try {
      if (!api.actorId || !current())
        throw new Error("Choose an authenticated account before controlling serving.");
      let saved = original;
      if (!saved) {
        if (!value)
          throw new Error("Read the exact saved version before reviewing a fresh serving command.");
        const intent = await freshIntent(
          api,
          modelProjectId,
          value,
          action,
          idleTimeoutSeconds,
          defaultPublication,
          defaultEnabled,
          spendingLimit,
        );
        const operation = await api.operation(ACTION, intent);
        if (!current()) return null;
        const { modelProjectId: selectedModelId, ...body } = intent;
        saved = {
          operation,
          command: Command.parse({
            modelProjectId: selectedModelId,
            request: { ...body, operationId: operation.id },
          }),
        };
      }
      patch({ retained: saved });
      await saved.operation.retainCommand(saved.command, "dispatching");
      if (!current()) return null;
      dispatched = saved;
      const raw = await apiFetch(
        api.connection,
        `/v1/training/saved-models/${encodeURIComponent(saved.command.modelProjectId)}/serving?${new URLSearchParams({ teamId: api.teamId, ...(saved.command.request.schemaVersion === "openpond.alphaEditModelServingControlRequest.v1" || saved.command.request.schemaVersion === "openpond.neuronTrainingModelServingControlRequest.v1" || saved.command.request.schemaVersion === "openpond.weightSpaceModelServingControlRequest.v1" || saved.command.request.schemaVersion === "openpond.decisionModelServingControlRequest.v1" ? { intentHash: saved.operation.intentHash, ...(api.projectId ? { projectId: api.projectId } : {}) } : {}) })}`,
        { method: "POST", body: JSON.stringify(saved.command.request) },
      );
      const response = await verifyReceipt(raw, saved.command, api.actorId);
      if (!current()) return null;
      patch({ receipt: response });
      void queries.invalidateQueries({ queryKey: ["saved-model-serving"] });
      try {
        await saved.operation.acknowledge();
      } catch (reason) {
        patch({ error: reason });
        return null;
      }
      if (!current()) return null;
      patch({ retained: null });
      await pending.refetch();
      return current() ? response : null;
    } catch (reason) {
      if (current()) {
        patch({ error: reason });
        if (dispatched && definitive(reason, dispatched)) {
          try {
            await dispatched.operation.acknowledge();
            if (current()) {
              patch({ retained: null });
              await pending.refetch();
              void queries.invalidateQueries({ queryKey: ["saved-model-serving"] });
            }
          } catch (ackError) {
            patch({ error: ackError });
          }
        }
      }
      return null;
    } finally {
      active.current.delete(scope);
      patch({ busy: false });
    }
  }
  return {
    run,
    busy: state.busy,
    receipt: state.receipt,
    retained: original,
    recoveryReady: Boolean(original) || pending.isSuccess,
    refreshRecovery: pending.refetch,
    error: state.error ?? pending.error,
  };
}
