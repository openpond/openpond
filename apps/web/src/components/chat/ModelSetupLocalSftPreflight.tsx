import { useEffect, useRef, useState } from "react";
import type { z } from "zod";
import { LocalSftPreflightSchema, type LocalSftPreflightReportSchema, type ResourceSetupDraft } from "@openpond/contracts/resource-setup";
import { apiFetch, type ClientConnection } from "../../api/api-client";
import { useErrorToast } from "../../app/AppToastContext";
import { ModelSetupLocalSftRun } from "./ModelSetupLocalSftRun";

type Report = z.infer<typeof LocalSftPreflightReportSchema>;
const readiness: Record<Exclude<Report["status"], "ready">, string> = {
  unsupported_platform: "Local SFT requires Linux.",
  python_missing: "Set up the local training Python environment.",
  dependencies_missing: "Check the packages in the local training Python environment.",
  cuda_unavailable: "The tokenizer check passed. A CUDA GPU is required for this recipe.",
  checkpoint_mismatch: "Reimport the exact checkpoint and review the current inputs.",
  tokenizer_incompatible: "The tokenizer could not isolate the expected answer using this chat template.",
  example_too_long: "An approved example exceeds the sequence length. Adjust the settings or review a shorter example.",
  lora_incompatible: "The checkpoint does not support the selected LoRA rank or target layers.",
  insufficient_memory: "The approved batch exceeded the available GPU memory or the recipe’s memory limit.",
  nonfinite_loss: "The temporary training step produced a non-finite loss or gradient.",
  probe_failed: "The local training check could not finish.",
  device_busy: "Another local training run or check is using the device.",
};

const gib = (bytes: number) => (bytes / 1024 ** 3).toLocaleString(undefined, { maximumFractionDigits: 2 });

export function ModelSetupLocalSftPreflight({ approval, connection, localSelected, busy, onBusy }: {
  approval: NonNullable<ResourceSetupDraft["localSftApproval"]>;
  connection: ClientConnection;
  localSelected: boolean;
  busy: boolean;
  onBusy(busy: boolean): void;
}) {
  const [report, setReport] = useState<Report>();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const inFlight = useRef<AbortController | null>(null);
  useErrorToast(error);
  useEffect(() => () => inFlight.current?.abort(), []);

  async function check() {
    if (busy || inFlight.current) return;
    const controller = new AbortController();
    inFlight.current = controller;
    setReport(undefined);
    setError(null);
    setChecking(true);
    onBusy(true);
    try {
      const result = LocalSftPreflightSchema.parse(await apiFetch(connection, "/v1/training/local-sft/check", {
        method: "POST",
        body: JSON.stringify({ sessionId: approval.request.sessionId, planHash: approval.planHash }),
        signal: controller.signal,
      }));
      if (result.planHash !== approval.planHash) throw new Error("The device check returned a different SFT review.");
      if (!controller.signal.aborted) setReport(result.report);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause);
    } finally {
      inFlight.current = null;
      setChecking(false);
      onBusy(false);
    }
  }

  return <div className="resource-setup-input">
    <div className="resource-setup-presets">
      <button type="button" className="training-button secondary" disabled={busy || checking} onClick={() => void check()}>
        {checking ? "Checking this device" : "Check this device"}
      </button>
      {checking ? <button type="button" className="training-button secondary" onClick={() => inFlight.current?.abort()}>
        Cancel check
      </button> : null}
    </div>
    {report ? <div className="resource-setup-input" role="status">
      <strong>{report.status === "ready" ? "Device check passed" : readiness[report.status]}</strong>
      {report.status === "ready" ? <span>{report.device.name}. {gib(report.device.usedBytes)} GiB measured peak within {gib(report.device.budgetBytes)} GiB available to the recipe.</span>
        : report.rowId ? <small>Training example {report.rowId}</small> : null}
      {report.tokens ? <span>{report.tokens.rowCount} examples checked. Longest sequence {report.tokens.maximumTokens.toLocaleString()} tokens.</span> : null}
    </div> : null}
    <ModelSetupLocalSftRun sessionId={approval.request.sessionId} planHash={approval.planHash} connection={connection} busy={busy}
      canStart={localSelected && report?.status === "ready"} />
  </div>;
}
