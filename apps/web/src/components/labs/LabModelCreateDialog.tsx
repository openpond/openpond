import { useMemo, useState, type FormEvent } from "react";
import type {
  BaseModelCandidate,
  BaseModelPreference,
} from "@openpond/contracts";

import { AppDialog } from "../dialogs/AppDialog";
import { X } from "../icons";

export type LabModelCreateInput = {
  name: string;
  description: string | null;
  defaultBaseModel: BaseModelPreference | null;
};

export function LabModelCreateDialog({
  baseModelCandidates,
  busy,
  initialName,
  onClose,
  onCreate,
  onManageModels,
}: {
  baseModelCandidates: BaseModelCandidate[];
  busy: boolean;
  initialName: string;
  onClose: () => void;
  onCreate: (input: LabModelCreateInput) => Promise<boolean>;
  onManageModels: () => void;
}) {
  const listedCandidates = useMemo(
    () => labModelCreateCandidates(baseModelCandidates),
    [baseModelCandidates],
  );
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState("");
  const [baseModelKey, setBaseModelKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const normalizedName = name.trim().replace(/\s+/g, " ");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!normalizedName || busy) return;
    setError(null);
    const selected =
      listedCandidates.find(
        (candidate) => candidate.selectionKey === baseModelKey,
      ) ?? null;
    const created = await onCreate({
      name: normalizedName,
      description: description.trim() || null,
      defaultBaseModel: selected?.preference ?? null,
    });
    if (!created) {
      setError("OpenPond could not create the Model. Review the latest error and try again.");
    }
  }

  return (
    <AppDialog
      ariaLabel="New model"
      backdropClassName="labs-rename-backdrop"
      className="labs-rename-dialog labs-model-create-dialog"
      dismissDisabled={busy}
      initialFocusKey={initialName}
      onClose={onClose}
    >
      <header>
        <div>
          <h2>New model</h2>
          <p>Create the Model now. Tasksets, runs, and releases can be added later.</p>
        </div>
        <button
          aria-label="Close new model"
          disabled={busy}
          type="button"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      <form onSubmit={(event) => void submit(event)}>
        <label>
          <span>Name</span>
          <input
            data-autofocus
            maxLength={200}
            required
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
          />
        </label>
        <label>
          <span>Description <small>Optional</small></span>
          <textarea
            maxLength={5_000}
            rows={3}
            value={description}
            onChange={(event) => setDescription(event.currentTarget.value)}
          />
        </label>
        <div className="labs-model-create-field">
          <span>Starting model <small>Optional</small></span>
          <div className="labs-model-create-select-row">
            <select
              aria-label="Starting model"
              value={baseModelKey}
              onChange={(event) => setBaseModelKey(event.currentTarget.value)}
            >
              <option value="">Choose later</option>
              {listedCandidates.map((candidate) => (
                <option
                  disabled={!candidate.available}
                  key={candidate.selectionKey}
                  value={candidate.selectionKey}
                >
                  {candidate.label} · {candidate.sourceLabel}
                  {candidate.available ? "" : " · Unavailable"}
                </option>
              ))}
            </select>
            <button
              aria-label="Add starting model"
              className="labs-model-create-add"
              disabled={busy}
              title="Manage models in Compute settings"
              type="button"
              onClick={onManageModels}
            >
              +
            </button>
          </div>
        </div>
        {error ? (
          <div className="labs-rename-error" role="alert">{error}</div>
        ) : null}
        <footer>
          <button disabled={busy} type="button" onClick={onClose}>
            Cancel
          </button>
          <button disabled={!normalizedName || busy} type="submit">
            {busy ? "Creating…" : "Create model"}
          </button>
        </footer>
      </form>
    </AppDialog>
  );
}

export function labModelCreateCandidates(
  candidates: BaseModelCandidate[],
): BaseModelCandidate[] {
  return candidates.filter(
    (candidate) =>
      !(
        candidate.preference.source === "builtin"
        && candidate.nonProduction
      ),
  );
}
