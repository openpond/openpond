import type { BaseModelCandidate } from "@openpond/contracts";
import { Boxes, Loader2, RefreshCw } from "../icons";

export function TrainingBaseModelStep({
  busy,
  candidates,
  value,
  onChange,
  onContinue,
  onManage,
  onScan,
}: {
  busy: boolean;
  candidates: BaseModelCandidate[];
  value: string | null;
  onChange: (selectionKey: string) => void;
  onContinue: () => void;
  onManage: () => void;
  onScan: () => void;
}) {
  const selected = candidates.find((candidate) =>
    candidate.selectionKey === value && candidate.available) ?? null;
  const groups = candidateGroups(candidates);
  const autofocusKey = value
    ?? candidates.find((candidate) => candidate.available)?.selectionKey
    ?? null;

  return (
    <>
      <div
        aria-label="Starting-weight choices"
        className="training-dialog-scroll-body training-base-model-scroll"
        role="region"
        tabIndex={0}
      >
        <div className="training-run-step-heading">
          <h3>Choose starting weights</h3>
          <p>
            Choose the model this Model should start from. Compute, provider,
            export, and spend are confirmed separately for each Version.
          </p>
        </div>
        <div className="training-inline-actions training-base-model-actions">
          <button
            className="training-button secondary"
            type="button"
            onClick={onManage}
          >
            <Boxes size={14} />
            Manage local models
          </button>
          <button
            className="training-button secondary"
            type="button"
            disabled={busy}
            onClick={onScan}
          >
            {busy ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
            {busy ? "Scanning" : "Scan this machine"}
          </button>
        </div>
        <div
          aria-label="Available base models"
          className="training-base-model-groups"
          role="radiogroup"
        >
          {groups.map((group) => (
            <section key={group.label} className="training-base-model-group">
              <div className="training-base-model-group-heading">
                <strong>{group.label}</strong>
                <small>{group.description}</small>
              </div>
              <div className="training-method-options training-base-model-options">
                {group.candidates.map((candidate) => (
                  <BaseModelCard
                    candidate={candidate}
                    key={candidate.selectionKey}
                    selected={candidate.selectionKey === value}
                    autofocus={candidate.selectionKey === autofocusKey}
                    onChange={onChange}
                    onContinue={onContinue}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
        {!candidates.length ? (
          <div className="training-banner">
            No training base models were found. Scan this machine, or manage
            local models to configure storage and download supported weights.
          </div>
        ) : null}
        <p className="training-start-note">
          This preference can be overridden for a Version, but OpenPond will not
          silently switch its base model or provider.
        </p>
      </div>
      <div className="training-dialog-actions">
        <button
          className="training-button"
          type="button"
          disabled={!selected}
          onClick={onContinue}
        >
          Continue
        </button>
      </div>
    </>
  );
}

function BaseModelCard({
  candidate,
  selected,
  autofocus,
  onChange,
  onContinue,
}: {
  candidate: BaseModelCandidate;
  selected: boolean;
  autofocus: boolean;
  onChange: (selectionKey: string) => void;
  onContinue: () => void;
}) {
  const disabled = !candidate.available;
  return (
    <button
      aria-checked={selected}
      aria-disabled={disabled}
      className={`${selected ? "selected" : ""}${disabled ? " unavailable" : ""}`}
      data-autofocus={!disabled && autofocus ? true : undefined}
      disabled={disabled}
      role="radio"
      type="button"
      onClick={() => onChange(candidate.selectionKey)}
      onDoubleClick={disabled ? undefined : onContinue}
    >
      <span className="training-base-model-icon" aria-hidden="true">
        <Boxes size={18} />
      </span>
      <span className="training-base-model-copy">
        <strong>{candidate.label}</strong>
        <small>{candidate.preference.modelId}</small>
        {candidate.preference.revision ? (
          <small>Revision {shortRevision(candidate.preference.revision)}</small>
        ) : null}
        {!candidate.available ? (
          <small className="training-base-model-reason">
            {candidate.unavailableReason}
          </small>
        ) : null}
      </span>
      <span className="training-base-model-tags" aria-hidden="true">
        <small>{candidate.sourceLabel}</small>
        {candidate.methods.map((method) => (
          <small key={method}>{method === "grpo" ? "RFT" : method.toUpperCase()}</small>
        ))}
        <small>LoRA</small>
        {candidate.nonProduction ? <small>Non-production</small> : null}
        {!candidate.available ? <small>Unavailable</small> : null}
      </span>
      <span className="training-choice-indicator" aria-hidden="true" />
    </button>
  );
}

function candidateGroups(candidates: BaseModelCandidate[]) {
  const available = candidates.filter((candidate) => candidate.available);
  const groups = [
    {
      label: "Managed",
      description: "Hosted training catalogs",
      candidates: available.filter((candidate) =>
        candidate.preference.source === "managed"),
    },
    {
      label: "This machine",
      description: "Verified local weights",
      candidates: available.filter((candidate) =>
        candidate.preference.source !== "managed"),
    },
    {
      label: "Unavailable",
      description: "Known choices that cannot run yet",
      candidates: candidates.filter((candidate) => !candidate.available),
    },
  ];
  return groups.filter((group) => group.candidates.length > 0);
}

function shortRevision(revision: string): string {
  return revision.length > 18 ? `${revision.slice(0, 18)}…` : revision;
}
