import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { ComputeDevice, ComputeStateResponse } from "@openpond/contracts";
import { RefreshCw } from "../icons";
import { ModelStoragePicker } from "./ModelStoragePicker";

export function ComputeSettingsSection({
  state,
  busy,
  onScan,
  onSave,
  onDownloadSmolLm2,
  onCancelDownload,
}: {
  state: ComputeStateResponse | null;
  busy: "load" | "scan" | "save" | null;
  onScan: () => Promise<void>;
  onSave: (modelStorePath: string | null, defaultDeviceIds: string[]) => Promise<boolean>;
  onDownloadSmolLm2: () => Promise<void>;
  onCancelDownload: (jobId: string) => Promise<void>;
}) {
  const inventory = state?.inventory ?? null;
  const [modelStorePath, setModelStorePath] = useState<string | null>(state?.settings.modelStorePath ?? null);
  const [deviceId, setDeviceId] = useState(state?.settings.defaultDeviceIds[0] ?? "automatic");
  useEffect(() => { setModelStorePath(state?.settings.modelStorePath ?? null); }, [state?.settings.modelStorePath]);
  useEffect(() => { setDeviceId(state?.settings.defaultDeviceIds[0] ?? "automatic"); }, [state?.settings.defaultDeviceIds]);
  const unchanged = modelStorePath === (state?.settings.modelStorePath ?? null) && deviceId === (state?.settings.defaultDeviceIds[0] ?? "automatic");
  const accelerators = useMemo(() => inventory?.devices.filter((device) => device.kind !== "cpu" && device.available) ?? [], [inventory?.devices]);
  const smol = inventory?.models.find((model) => model.modelId === "HuggingFaceTB/SmolLM2-135M-Instruct") ?? null;
  const download = [...(inventory?.downloads ?? [])].reverse().find((job) => job.modelId === "HuggingFaceTB/SmolLM2-135M-Instruct") ?? null;
  const downloadActive = Boolean(download && ["queued", "downloading", "verifying", "cancelling"].includes(download.status));

  async function save(event: FormEvent) {
    event.preventDefault();
    await onSave(modelStorePath, deviceId === "automatic" ? [] : [deviceId]);
  }

  return (
    <section className="account-settings compute-settings">
      <div className="compute-title-row">
        <h1>Compute</h1>
        <button className="settings-icon-button" type="button" title="Scan compute" aria-label="Scan compute" disabled={busy !== null} onClick={() => void onScan()}>
          <RefreshCw size={15} className={busy === "scan" ? "settings-spin" : undefined} />
        </button>
      </div>

      <div className="account-summary">
        <div className="account-summary-main compute-summary-main">
          <div>
            <strong>{inventory ? `${inventory.host.operatingSystem} · ${inventory.host.architecture}` : busy === "load" ? "Loading this machine" : "This machine has not been scanned"}</strong>
            <small>{inventory ? `${inventory.devices.length} device${inventory.devices.length === 1 ? "" : "s"} · ${formatBytes(inventory.host.totalMemoryBytes)} memory · scanned ${formatDate(inventory.scannedAt)}` : "Run a bounded native scan to discover local training capabilities."}</small>
          </div>
        </div>
      </div>

      <form className="provider-settings-form" onSubmit={(event) => void save(event)}>
        <div className="account-list-heading"><span>Defaults</span></div>
        <ModelStoragePicker disabled={busy !== null} storageRoots={inventory?.storageRoots ?? []} value={modelStorePath} onChange={setModelStorePath} />
        <div className="provider-settings-grid single compute-device-default">
          <label className="settings-select-field">
            <span>Default device</span>
            <select value={deviceId} disabled={busy !== null} onChange={(event) => setDeviceId(event.target.value)}>
              <option value="automatic">Automatic</option>
              {accelerators.map((device) => <option key={device.id} value={device.id}>{device.name}</option>)}
            </select>
          </label>
        </div>
        <button className="settings-primary" disabled={busy !== null || unchanged}>{busy === "save" ? "Saving" : "Save compute settings"}</button>
      </form>

      <ComputeList title="Devices" empty="No devices discovered" rows={(inventory?.devices ?? []).map((device) => ({ id: device.id, title: device.name, detail: deviceDetail(device), meta: device.available ? "Available" : device.unavailableReason ?? "Unavailable" }))} />
      <ComputeList title="Runtimes" empty="No runtimes discovered" rows={(inventory?.runtimes ?? []).map((runtime) => ({ id: runtime.id, title: runtimeLabel(runtime.kind), detail: runtime.version ?? runtime.detail ?? "Not installed", meta: runtime.state === "available" ? "Available" : "Unavailable" }))} />
      <div className="account-list"><div className="account-list-heading"><span>Models</span><div className="compute-heading-actions">{downloadActive && download ? <button type="button" className="settings-secondary" disabled={download.status === "cancelling"} onClick={() => void onCancelDownload(download.id)}>{download.status === "cancelling" ? "Cancelling" : "Cancel"}</button> : !smol ? <button type="button" className="settings-secondary" disabled={!state?.settings.modelStorePath} onClick={() => void onDownloadSmolLm2()}>Download SmolLM2</button> : null}<small>{inventory?.models.length ?? 0}</small></div></div>{download && !smol ? <div className="compute-download-row"><div><strong>SmolLM2 135M Instruct</strong><small>{download.status === "failed" ? download.error : `${statusLabel(download.status)} · ${formatBytes(download.downloadedBytes)} of ${formatBytes(download.expectedBytes)} · Apache-2.0`}</small></div><progress max={download.expectedBytes} value={download.downloadedBytes}/></div> : null}{inventory?.models.length ? inventory.models.map((model) => <div className="compute-row" key={model.id}><div><strong>{model.name}</strong><small>{model.source} · {model.format} · {formatBytes(model.sizeBytes)}</small></div><span>{model.trainingCompatible ? "Trainable" : model.inferenceCompatible ? "Inference only" : "Unsupported"}</span></div>) : download ? null : <div className="empty-account-list"><span>No recognized local models</span></div>}</div>

      {inventory?.warnings.length ? <details className="compute-diagnostics"><summary>Diagnostics</summary><ul>{inventory.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></details> : null}
    </section>
  );
}

function ComputeList({ title, empty, rows }: { title: string; empty: string; rows: Array<{ id: string; title: string; detail: string; meta: string }> }) {
  return <div className="account-list"><div className="account-list-heading"><span>{title}</span><small>{rows.length}</small></div>{rows.length ? rows.map((row) => <div className="compute-row" key={row.id}><div><strong>{row.title}</strong><small>{row.detail}</small></div><span>{row.meta}</span></div>) : <div className="empty-account-list"><span>{empty}</span></div>}</div>;
}
function deviceDetail(device: ComputeDevice): string { return [device.vendor, device.kind, device.totalMemoryBytes ? formatBytes(device.totalMemoryBytes) : null, device.computeCapability ? `compute ${device.computeCapability}` : null].filter(Boolean).join(" · "); }
function runtimeLabel(value: string): string { return value === "trl_peft" ? "TRL / PEFT" : value.toUpperCase(); }
function statusLabel(value: string): string { return value.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase()); }
function formatDate(value: string): string { const date = new Date(value); return Number.isNaN(date.valueOf()) ? value : date.toLocaleString(); }
function formatBytes(value: number | null | undefined): string { if (value == null) return "Unknown"; if (value < 1024) return `${value} B`; const units = ["KB", "MB", "GB", "TB"]; let amount = value; let unit = -1; do { amount /= 1024; unit += 1; } while (amount >= 1024 && unit < units.length - 1); return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`; }
