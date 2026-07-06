import { useMemo, useState, type ChangeEvent, type FormEvent } from "react";
import type { SandboxTemplateManifest } from "@openpond/contracts";
import {
  SANDBOX_TEMPLATE_PREVIEW_PORT_MAX,
  SANDBOX_TEMPLATE_PREVIEW_PORT_MIN,
} from "@openpond/contracts";
import { Boxes, ExternalLink, X } from "../icons";
import {
  buildSandboxEnvMappings,
  buildSandboxManifestModel,
  buildScalarParams,
  filterSandboxInputsForTarget,
  mergeFirstVolume,
  type SandboxCreateDialogInput,
  type SandboxFileInput,
  type SandboxScheduleSelection,
} from "./SandboxCreateDialogModel";

export type {
  SandboxCreateDialogInput,
  SandboxEnvInput,
  SandboxEnvMappingSelection,
  SandboxFileInput,
  SandboxFileUploadSelection,
  SandboxManifestModel,
  SandboxScalarInput,
  SandboxScheduleSelection,
  SandboxTemplateEntrypoint,
} from "./SandboxCreateDialogModel";
export {
  buildSandboxEnvMappings,
  buildSandboxManifestModel,
  buildScalarParams,
  filterSandboxInputsForTarget,
  mergeFirstVolume,
  finishSandboxPreviewPopup,
  openSandboxPreviewPopup,
  previewUrlFromWorkspaceToolResult,
} from "./SandboxCreateDialogModel";

export function SandboxCreateDialog({
  busy,
  defaultRepoUrl,
  projectName,
  commitBeforeCreate,
  templateManifest,
  uploadBeforeCreate,
  onClose,
  onSubmit,
}: {
  busy: boolean;
  defaultRepoUrl: string;
  projectName: string;
  commitBeforeCreate: boolean;
  templateManifest?: SandboxTemplateManifest | null;
  uploadBeforeCreate: boolean;
  onClose: () => void;
  onSubmit: (input: SandboxCreateDialogInput) => void;
}) {
  const model = useMemo(() => buildSandboxManifestModel(templateManifest), [templateManifest]);
  const firstEntrypoint = model.entrypoints[0] ?? null;
  const [repoUrl, setRepoUrl] = useState(defaultRepoUrl);
  const [entrypointName, setEntrypointName] = useState(firstEntrypoint?.name ?? "");
  const [command, setCommand] = useState(firstEntrypoint?.command ?? "");
  const [timeoutSeconds, setTimeoutSeconds] = useState(firstEntrypoint?.timeoutSeconds ? String(firstEntrypoint.timeoutSeconds) : "");
  const [commitMessage, setCommitMessage] = useState(`Update ${projectName}`);
  const [budgetUsd, setBudgetUsd] = useState("0.05");
  const [scalarValues, setScalarValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(model.scalarInputs.map((input) => [input.name, input.defaultValue])),
  );
  const [envSecretRefs, setEnvSecretRefs] = useState<Record<string, string>>(() =>
    Object.fromEntries(model.envInputs.map((input) => [input.name, ""])),
  );
  const [fileValues, setFileValues] = useState<Record<string, File[]>>({});
  const firstVolume = model.volumes[0] ?? null;
  const [createVolume, setCreateVolume] = useState(model.volumes.length > 0 || model.fileInputs.length > 0);
  const [volumeName, setVolumeName] = useState(firstVolume?.name ?? "volume");
  const [volumeMountPath, setVolumeMountPath] = useState(firstVolume?.mountPath ?? "/workspace/volumes/volume");
  const [volumeStorageGb, setVolumeStorageGb] = useState(String(firstVolume?.storageGb ?? 8));
  const [keepVolume, setKeepVolume] = useState(!(firstVolume?.deleteOnSandboxDelete ?? false));
  const [scheduleDrafts, setScheduleDrafts] = useState<SandboxScheduleSelection[]>(model.schedules);
  const selectedEntrypoint = model.entrypoints.find((entrypoint) => entrypoint.name === entrypointName) ?? firstEntrypoint;
  const previewPorts = selectedEntrypoint?.ports ?? [];
  const firstPreviewPort = previewPorts[0] ?? null;
  const [openPreview, setOpenPreview] = useState(Boolean(firstPreviewPort));
  const [previewPort, setPreviewPort] = useState(firstPreviewPort ? String(firstPreviewPort.port) : "");
  const portNumber = Number(previewPort);
  const budgetNumber = Number(budgetUsd);
  const volumeStorageNumber = Number(volumeStorageGb);
  const timeoutNumber = Number(timeoutSeconds);
  const validTimeout =
    !timeoutSeconds.trim() ||
    (Number.isInteger(timeoutNumber) && timeoutNumber > 0 && timeoutNumber <= 86_400);
  const validPreviewPort =
    !openPreview ||
    (Number.isInteger(portNumber) &&
      portNumber >= SANDBOX_TEMPLATE_PREVIEW_PORT_MIN &&
      portNumber <= SANDBOX_TEMPLATE_PREVIEW_PORT_MAX &&
      previewPorts.some((port) => port.port === portNumber));
  const validBudget = Number.isFinite(budgetNumber) && budgetNumber > 0;
  const validVolume = !createVolume || (Number.isInteger(volumeStorageNumber) && volumeStorageNumber > 0);
  const validSchedules = scheduleDrafts.every(
    (schedule) => !schedule.enabled || Boolean(schedule.scheduleExpression.trim()),
  );
  const visibleScalarInputs = filterSandboxInputsForTarget(model.scalarInputs, entrypointName);
  const visibleFileInputs = filterSandboxInputsForTarget(model.fileInputs, entrypointName);
  const requiredEnvRefsPresent = model.envInputs.every(
    (input) => !input.required || Boolean((envSecretRefs[input.name] ?? "").trim()),
  );
  const missingRequiredEnvInputs = model.envInputs.filter(
    (input) => input.required && !(envSecretRefs[input.name] ?? "").trim(),
  );
  const canSubmit =
    (uploadBeforeCreate || Boolean(repoUrl.trim())) &&
    Boolean(command.trim()) &&
    validBudget &&
    validTimeout &&
    validVolume &&
    visibleScalarInputs.every(
      (input) => !input.required || Boolean((scalarValues[input.name] ?? "").trim()),
    ) &&
    visibleFileInputs.every(
      (input) => !input.required || (fileValues[input.name]?.length ?? 0) > 0,
    ) &&
    requiredEnvRefsPresent &&
    validSchedules &&
    validPreviewPort;

  function updateEntrypoint(nextName: string) {
    setEntrypointName(nextName);
    const nextEntrypoint = model.entrypoints.find((entrypoint) => entrypoint.name === nextName);
    if (!nextEntrypoint) return;
    setCommand(nextEntrypoint.command);
    setTimeoutSeconds(nextEntrypoint.timeoutSeconds ? String(nextEntrypoint.timeoutSeconds) : "");
    const nextPreviewPort = nextEntrypoint.ports[0] ?? null;
    setPreviewPort(nextPreviewPort ? String(nextPreviewPort.port) : "");
    setOpenPreview(Boolean(nextPreviewPort));
  }

  function updateScalar(name: string, value: string) {
    setScalarValues((current) => ({ ...current, [name]: value }));
  }

  function updateEnvSecretRef(name: string, secretRef: string) {
    setEnvSecretRefs((current) => ({ ...current, [name]: secretRef }));
  }

  function updateFiles(input: SandboxFileInput, event: ChangeEvent<HTMLInputElement>) {
    const nextFiles = Array.from(event.target.files ?? []);
    setFileValues((current) => ({
      ...current,
      [input.name]: input.multiple ? nextFiles : nextFiles.slice(0, 1),
    }));
  }

  function updateSchedule(index: number, patch: Partial<SandboxScheduleSelection>) {
    setScheduleDrafts((current) =>
      current.map((schedule, scheduleIndex) =>
        scheduleIndex === index ? { ...schedule, ...patch } : schedule,
      ),
    );
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || busy) return;
    onSubmit({
      repoUrl: repoUrl.trim(),
      command: command.trim(),
      entrypointName,
      commitMessage: commitMessage.trim(),
      budgetUsd: budgetUsd.trim(),
      params: buildScalarParams(visibleScalarInputs, scalarValues),
      env: buildSandboxEnvMappings(model.envInputs, envSecretRefs),
      timeoutSeconds:
        timeoutSeconds.trim() && Number.isInteger(timeoutNumber)
          ? timeoutNumber
          : selectedEntrypoint?.timeoutSeconds ?? null,
      uploads: visibleFileInputs.flatMap((input) => {
        const files = fileValues[input.name] ?? [];
        return files.length > 0
          ? [{ inputName: input.name, label: input.label, targetPath: input.targetPath, multiple: input.multiple, files }]
          : [];
      }),
      resources: model.resources,
      volumes: createVolume
        ? mergeFirstVolume(model.volumes, {
            ...(volumeName.trim() ? { name: volumeName.trim() } : {}),
            ...(volumeMountPath.trim() ? { mountPath: volumeMountPath.trim() } : {}),
            ...(Number.isInteger(volumeStorageNumber) && volumeStorageNumber > 0
              ? { storageGb: volumeStorageNumber }
              : {}),
            deleteOnSandboxDelete: !keepVolume,
          })
        : [],
      schedules: scheduleDrafts.filter((schedule) => schedule.enabled),
      openPreview,
      previewPort: openPreview ? portNumber : null,
      previewLabel: previewPorts.find((port) => port.port === portNumber)?.label ?? "web",
      previewAccess: previewPorts.find((port) => port.port === portNumber)?.access ?? "private",
    });
  }

  return (
    <div className="git-dialog-backdrop" role="presentation">
      <form className="git-dialog run-once-dialog sandbox-start-dialog" role="dialog" aria-modal="true" aria-label="Start sandbox" onSubmit={submit}>
        <button className="git-dialog-close" disabled={busy} type="button" title="Close" aria-label="Close" onClick={onClose}>
          <X size={15} />
        </button>
        <div className="sandbox-start-dialog-heading">
          <div className="git-dialog-icon">
            <Boxes size={18} />
          </div>
          <h2>Start sandbox</h2>
          <div className="git-dialog-row">
            <span>Project</span>
            <strong>{projectName}</strong>
          </div>
        </div>
        <div className="sandbox-start-dialog-body">
        {uploadBeforeCreate ? null : (
          <label className="git-dialog-field">
            <span>Repository</span>
            <input disabled={busy} value={repoUrl} onChange={(event) => setRepoUrl(event.target.value)} />
          </label>
        )}
        {commitBeforeCreate ? (
          <label className="git-dialog-field">
            <span>Commit message</span>
            <input disabled={busy} value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} />
          </label>
        ) : null}
        {model.entrypoints.length > 0 ? (
          <label className="git-dialog-field">
            <span>Run target</span>
            <select disabled={busy} value={entrypointName} onChange={(event) => updateEntrypoint(event.target.value)}>
              {model.entrypoints.map((entrypoint) => (
                <option key={entrypoint.name} value={entrypoint.name}>
                  {entrypoint.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="git-dialog-field">
          <span>Shell command</span>
          <input disabled={busy} value={command} onChange={(event) => setCommand(event.target.value)} />
        </label>
        <label className="git-dialog-field">
          <span>Timeout seconds</span>
          <input disabled={busy} inputMode="numeric" value={timeoutSeconds} onChange={(event) => setTimeoutSeconds(event.target.value)} />
        </label>
        {visibleScalarInputs.map((input) =>
          input.type === "boolean" ? (
            <label className="git-dialog-toggle" key={input.name}>
              <input
                checked={(scalarValues[input.name] ?? "") === "true"}
                disabled={busy}
                type="checkbox"
                onChange={(event) => updateScalar(input.name, event.target.checked ? "true" : "false")}
              />
              <span />
              {input.label}
            </label>
          ) : (
            <label className="git-dialog-field" key={input.name}>
              <span>{input.label}</span>
              <input
                disabled={busy}
                inputMode={input.type === "number" || input.type === "integer" ? "decimal" : undefined}
                value={scalarValues[input.name] ?? ""}
                onChange={(event) => updateScalar(input.name, event.target.value)}
              />
            </label>
          ),
        )}
        {visibleFileInputs.map((input) => (
          <label className="git-dialog-field" key={input.name}>
            <span>{input.label}</span>
            <input
              accept={input.accept || undefined}
              disabled={busy}
              multiple={input.multiple}
              type="file"
              onChange={(event) => updateFiles(input, event)}
            />
          </label>
        ))}
        {model.envInputs.length > 0 ? (
          <div className="sandbox-start-env-section">
            <div className="sandbox-start-section-title">Environment</div>
            {missingRequiredEnvInputs.length > 0 ? (
              <p className="sandbox-start-env-warning" role="status">
                Required sandbox secret ref missing: {missingRequiredEnvInputs.map((input) => input.name).join(", ")}
              </p>
            ) : null}
            {model.envInputs.map((input) => {
              const secretRef = envSecretRefs[input.name] ?? "";
              const missing = input.required && !secretRef.trim();
              const descriptionId = `sandbox-env-${input.name}-description`;
              return (
                <label className="git-dialog-field" key={input.name}>
                  <span>{input.name}{input.required ? " *" : ""}</span>
                  <input
                    aria-describedby={descriptionId}
                    aria-invalid={missing}
                    disabled={busy}
                    placeholder="openpond://secret/..."
                    value={secretRef}
                    onChange={(event) => updateEnvSecretRef(input.name, event.target.value)}
                  />
                  <small id={descriptionId}>
                    {missing ? "Add a sandbox secret ref before starting." : input.description || "Sandbox secret ref only."}
                  </small>
                </label>
              );
            })}
          </div>
        ) : null}
        {visibleFileInputs.length > 0 || model.volumes.length > 0 ? (
          <>
            <label className="git-dialog-toggle">
              <input checked={createVolume} disabled={busy} type="checkbox" onChange={(event) => setCreateVolume(event.target.checked)} />
              <span />
              Mount volume
            </label>
            {createVolume ? (
              <>
                <div className="run-once-dialog-grid">
                  <label className="git-dialog-field">
                    <span>Volume</span>
                    <input disabled={busy} value={volumeName} onChange={(event) => setVolumeName(event.target.value)} />
                  </label>
                  <label className="git-dialog-field">
                    <span>Storage GiB</span>
                    <input disabled={busy} inputMode="numeric" value={volumeStorageGb} onChange={(event) => setVolumeStorageGb(event.target.value)} />
                  </label>
                </div>
                <label className="git-dialog-field">
                  <span>Mount path</span>
                  <input disabled={busy} value={volumeMountPath} onChange={(event) => setVolumeMountPath(event.target.value)} />
                </label>
                <label className="git-dialog-toggle">
                  <input checked={keepVolume} disabled={busy} type="checkbox" onChange={(event) => setKeepVolume(event.target.checked)} />
                  <span />
                  Keep volume
                </label>
              </>
            ) : null}
          </>
        ) : null}
        {scheduleDrafts.length > 0 ? (
          <div className="sandbox-start-schedules">
            <div className="sandbox-start-section-title">Schedules</div>
            {scheduleDrafts.map((schedule, index) => (
              <div className="sandbox-start-schedule-row" key={schedule.name}>
                <label className="git-dialog-toggle">
                  <input
                    checked={schedule.enabled}
                    disabled={busy}
                    type="checkbox"
                    onChange={(event) => updateSchedule(index, { enabled: event.target.checked })}
                  />
                  <span />
                  {schedule.name}
                </label>
                <div className="run-once-dialog-grid">
                  <label className="git-dialog-field">
                    <span>Type</span>
                    <select
                      disabled={busy || !schedule.enabled}
                      value={schedule.scheduleType}
                      onChange={(event) =>
                        updateSchedule(index, {
                          scheduleType: event.target.value as SandboxScheduleSelection["scheduleType"],
                        })
                      }
                    >
                      <option value="rate">Rate</option>
                      <option value="cron">Cron</option>
                      <option value="once">Once</option>
                    </select>
                  </label>
                  <label className="git-dialog-field">
                    <span>Max runs</span>
                    <input
                      disabled={busy || !schedule.enabled}
                      inputMode="numeric"
                      value={schedule.maxRuns ?? ""}
                      onChange={(event) => {
                        const next = Number(event.target.value);
                        updateSchedule(index, {
                          maxRuns: Number.isInteger(next) && next > 0 ? next : null,
                        });
                      }}
                    />
                  </label>
                </div>
                <label className="git-dialog-field">
                  <span>Expression</span>
                  <input
                    disabled={busy || !schedule.enabled}
                    value={schedule.scheduleExpression}
                    onChange={(event) => updateSchedule(index, { scheduleExpression: event.target.value })}
                  />
                </label>
              </div>
            ))}
          </div>
        ) : null}
        <label className="git-dialog-field">
          <span>Budget</span>
          <input disabled={busy} inputMode="decimal" value={budgetUsd} onChange={(event) => setBudgetUsd(event.target.value)} />
        </label>
        {previewPorts.length > 0 ? (
          <>
            <label className="git-dialog-toggle">
              <input checked={openPreview} disabled={busy} type="checkbox" onChange={(event) => setOpenPreview(event.target.checked)} />
              <span />
              Open preview
            </label>
            <label className="git-dialog-field">
              <span>Preview port</span>
              <select disabled={busy || !openPreview} value={previewPort} onChange={(event) => setPreviewPort(event.target.value)}>
                {previewPorts.map((port) => (
                  <option key={port.port} value={port.port}>
                    {port.label ? `${port.label} (${port.port})` : port.port}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : null}
        </div>
        <div className="git-dialog-footer sandbox-start-dialog-footer">
          <button className="git-dialog-secondary" disabled={busy} type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="git-dialog-primary"
            disabled={busy || !canSubmit}
            title={!requiredEnvRefsPresent ? "Required sandbox secret refs are missing." : undefined}
            type="submit"
          >
            <ExternalLink size={14} />
            Start
          </button>
        </div>
      </form>
    </div>
  );
}
