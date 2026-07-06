import { useMemo, useState, type ChangeEvent, type FormEvent } from "react";
import type { SandboxTemplateManifest } from "@openpond/contracts";
import { sandboxTemplateExecutableEntries } from "@openpond/contracts";
import { Play, X } from "../icons";
import {
  buildSandboxEnvMappings,
  buildSandboxManifestModel,
  buildScalarParams,
  filterSandboxInputsForTarget,
  type SandboxEnvMappingSelection,
  type SandboxFileUploadSelection,
} from "./SandboxCreateDialog";

export type SandboxRunActionDialogInput = {
  mode: "sandbox" | "local";
  target: string;
  params: Record<string, unknown>;
  env: SandboxEnvMappingSelection[];
  uploads: SandboxFileUploadSelection[];
};

export function SandboxRunActionDialog({
  busy,
  projectName,
  templateManifest,
  onClose,
  onSubmit,
}: {
  busy: boolean;
  projectName: string;
  templateManifest?: SandboxTemplateManifest | null;
  onClose: () => void;
  onSubmit: (input: SandboxRunActionDialogInput) => void;
}) {
  const model = useMemo(() => buildSandboxManifestModel(templateManifest), [templateManifest]);
  const actions = useMemo(
    () => (templateManifest ? sandboxTemplateExecutableEntries(templateManifest).filter((entry) => entry.kind === "action") : []),
    [templateManifest],
  );
  const firstAction = actions[0] ?? null;
  const [mode, setMode] = useState<"sandbox" | "local">("sandbox");
  const [target, setTarget] = useState(firstAction?.name ?? "");
  const [scalarValues, setScalarValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(model.scalarInputs.map((input) => [input.name, input.defaultValue])),
  );
  const [envSecretRefs, setEnvSecretRefs] = useState<Record<string, string>>(() =>
    Object.fromEntries(model.envInputs.map((input) => [input.name, ""])),
  );
  const [fileValues, setFileValues] = useState<Record<string, File[]>>({});
  const visibleScalarInputs = filterSandboxInputsForTarget(model.scalarInputs, target);
  const visibleFileInputs = filterSandboxInputsForTarget(model.fileInputs, target);
  const visibleEnvInputs = mode === "sandbox" ? model.envInputs : [];
  const requiredScalarsPresent = visibleScalarInputs.every(
    (input) => !input.required || Boolean((scalarValues[input.name] ?? "").trim()),
  );
  const requiredFilesPresent = visibleFileInputs.every(
    (input) => !input.required || (fileValues[input.name]?.length ?? 0) > 0,
  );
  const requiredEnvRefsPresent = visibleEnvInputs.every(
    (input) => !input.required || Boolean((envSecretRefs[input.name] ?? "").trim()),
  );
  const missingRequiredEnvInputs = visibleEnvInputs.filter(
    (input) => input.required && !(envSecretRefs[input.name] ?? "").trim(),
  );
  const canSubmit = Boolean(target) && requiredScalarsPresent && requiredFilesPresent && requiredEnvRefsPresent;

  function updateScalar(name: string, value: string) {
    setScalarValues((current) => ({ ...current, [name]: value }));
  }

  function updateEnvSecretRef(name: string, secretRef: string) {
    setEnvSecretRefs((current) => ({ ...current, [name]: secretRef }));
  }

  function updateFiles(inputName: string, multiple: boolean, event: ChangeEvent<HTMLInputElement>) {
    const nextFiles = Array.from(event.target.files ?? []);
    setFileValues((current) => ({
      ...current,
      [inputName]: multiple ? nextFiles : nextFiles.slice(0, 1),
    }));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || busy) return;
    onSubmit({
      mode,
      target,
      params: buildScalarParams(visibleScalarInputs, scalarValues),
      env: mode === "sandbox" ? buildSandboxEnvMappings(visibleEnvInputs, envSecretRefs) : [],
      uploads: visibleFileInputs.flatMap((input) => {
        const files = fileValues[input.name] ?? [];
        return files.length > 0
          ? [{ inputName: input.name, label: input.label, targetPath: input.targetPath, multiple: input.multiple, files }]
          : [];
      }),
    });
  }

  return (
    <div className="git-dialog-backdrop" role="presentation">
      <form className="git-dialog run-once-dialog sandbox-start-dialog" role="dialog" aria-modal="true" aria-label="Run sandbox action" onSubmit={submit}>
        <button className="git-dialog-close" disabled={busy} type="button" title="Close" aria-label="Close" onClick={onClose}>
          <X size={15} />
        </button>
        <div className="sandbox-start-dialog-heading">
          <div className="git-dialog-icon">
            <Play size={18} />
          </div>
          <h2>Run action</h2>
          <div className="git-dialog-row">
            <span>Project</span>
            <strong>{projectName}</strong>
          </div>
        </div>
        <div className="sandbox-start-dialog-body">
          <label className="git-dialog-field">
            <span>Action</span>
            <select disabled={busy || actions.length === 0} value={target} onChange={(event) => setTarget(event.target.value)}>
              {actions.map((action) => (
                <option key={action.name} value={action.name}>
                  {action.name}
                </option>
              ))}
            </select>
          </label>
          <label className="git-dialog-field">
            <span>Run on</span>
            <select disabled={busy} value={mode} onChange={(event) => setMode(event.target.value === "local" ? "local" : "sandbox")}>
              <option value="sandbox">Hosted sandbox (start/update)</option>
              <option value="local">Local machine</option>
            </select>
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
                onChange={(event) => updateFiles(input.name, input.multiple, event)}
              />
            </label>
          ))}
          {visibleEnvInputs.length > 0 ? (
            <div className="sandbox-start-env-section">
              <div className="sandbox-start-section-title">Environment</div>
              {missingRequiredEnvInputs.length > 0 ? (
                <p className="sandbox-start-env-warning" role="status">
                  Required sandbox secret ref missing: {missingRequiredEnvInputs.map((input) => input.name).join(", ")}
                </p>
              ) : null}
              {visibleEnvInputs.map((input) => {
                const secretRef = envSecretRefs[input.name] ?? "";
                const missing = input.required && !secretRef.trim();
                const descriptionId = `sandbox-action-env-${input.name}-description`;
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
                      {missing ? "Add a sandbox secret ref before running." : input.description || "Sandbox secret ref only."}
                    </small>
                  </label>
                );
              })}
            </div>
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
            <Play size={14} />
            Run
          </button>
        </div>
      </form>
    </div>
  );
}
