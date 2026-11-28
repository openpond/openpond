import { useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LocalSftRunSchema, type LocalSftRun } from "@openpond/contracts/resource-setup";
import { apiFetch, type ClientConnection } from "../../api/api-client";
import { useErrorToast } from "../../app/AppToastContext";
import { connectionQueryScope } from "../../lib/query-scope";

const statusLabel = {
  starting: "Starting local training",
  cancelling: "Cancelling local training",
  running: "Training on this device",
  completed: "Local adapter saved",
  cancelled: "Local training cancelled",
  failed: "Local training failed",
};
const explanation: Record<string, string> = {
  time_limit: "The run reached its approved time limit.",
  device_busy: "Another local training run is using the device.",
  artifact_invalid: "The saved adapter failed verification.",
  worker_failed: "The local training process returned an invalid result.",
  worker_stopped: "The local training process stopped before saving an adapter.",
  python_missing: "Set up the local training Python environment.",
  dependencies_missing: "Check the packages in the local training Python environment.",
  cuda_unavailable: "The run could not access a CUDA GPU.",
  checkpoint_mismatch: "Reimport the exact local checkpoint and review the inputs again.",
  tokenizer_incompatible: "The tokenizer could not use the approved examples and chat template.",
  example_too_long: "An approved training example exceeds the sequence length.",
  lora_incompatible: "The checkpoint does not support the approved LoRA settings.",
  insufficient_memory: "The run reached its GPU memory limit. Check this device again before retrying.",
  nonfinite_loss: "The run produced a non-finite loss, gradient, or adapter weight.",
  probe_failed: "The device check could not finish at launch.",
};
function isActive(status: string | undefined) {
  return status === "starting" || status === "running" || status === "cancelling";
}

export function ModelSetupLocalSftRun({ sessionId, planHash, attemptId, connection, canStart, busy }: {
  sessionId: string;
  planHash: string;
  attemptId?: string;
  connection: ClientConnection;
  canStart?: boolean;
  busy?: boolean;
}) {
  const queryClient = useQueryClient();
  const pendingStart = useRef<string | null>(null);
  const scope = connectionQueryScope(connection);
  const key = ["local-sft-run", scope, sessionId, planHash, attemptId] as const;
  async function load(operation: "start" | "cancel" | "status", runId?: string, signal?: AbortSignal): Promise<LocalSftRun> {
    const result = LocalSftRunSchema.parse(await apiFetch(connection, `/v1/training/local-sft/${operation}`, {
      method: "POST", body: JSON.stringify({ sessionId, planHash, runId }), signal,
    }));
    if (result.planHash !== planHash || runId && result.run?.id !== runId) {
      throw new Error("The local training response did not match the selected run.");
    }
    return result;
  }
  const status = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => load("status", attemptId, signal),
    refetchInterval: query => isActive(query.state.data?.run?.state.status) ? 1_000 : false,
    retry: false,
  });
  const change = useMutation({
    mutationFn: async ({ operation, id }: { operation: "start" | "cancel"; id: string }) => {
      await queryClient.cancelQueries({ queryKey: key });
      return load(operation, id);
    },
    onSuccess(result, { operation }) {
      if (operation === "start") pendingStart.current = null;
      queryClient.setQueryData(key, result);
      void queryClient.invalidateQueries({ queryKey: ["training-navigation", scope] });
      void queryClient.invalidateQueries({ queryKey: ["training", scope] });
    },
    onError: () => queryClient.invalidateQueries({ queryKey: key }),
  });
  useErrorToast(change.error ?? status.error);
  const run = status.data?.run;
  const state = run?.state;
  const active = isActive(state?.status);
  return <div className="resource-setup-input">
    {state && run ? <div className="resource-setup-input" role="status">
      <strong>{statusLabel[state.status]}</strong>
      {"device" in state && state.device ? <span>{state.device.name}</span> : null}
      {"steps" in state && state.steps !== undefined ? <span>{state.step} of {state.steps} optimizer steps</span> : null}
      {state.status === "failed" ? <span>{explanation[state.reason] ?? "The run could not finish."}</span> : null}
      {state.status === "completed" ? <small title={state.files["adapter_model.safetensors"].sha256}>
        Adapter {state.files["adapter_model.safetensors"].sha256.slice(0, 12)}
      </small> : null}
      <small title={run.id}>Run {run.id.slice(0, 8)}</small>
    </div> : null}
    {active && run ? <button type="button" className="training-button secondary"
      disabled={change.isPending || state?.status === "cancelling"}
      onClick={() => change.mutate({ operation: "cancel", id: run.id })}>Cancel local training</button>
      : canStart ? <button type="button" className="training-button"
        disabled={busy || status.isPending || change.isPending}
        onClick={() => {
          const id = pendingStart.current ??= crypto.randomUUID();
          change.mutate({ operation: "start", id });
        }}>Start local training</button> : null}
  </div>;
}
