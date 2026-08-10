import { useMemo, useState, type FormEvent } from "react";
import type {
  BaseModelCandidate,
  BaseModelPreference,
  ChatModelRef,
  ChatProvider,
  ProviderSettings,
} from "@openpond/contracts";

import { AppDialog } from "../dialogs/AppDialog";
import { DropdownSelect } from "../DropdownSelect";
import { X } from "../icons";
import {
  chatProviderLabel,
  modelOptionsForProvider,
  providerOptionsFromSettings,
} from "../../lib/app-models";

export type LabModelCreateInput = {
  name: string;
  description: string | null;
  defaultBaseModel: BaseModelPreference | null;
  benchmarkModel: ChatModelRef | null;
  purpose: "train" | "benchmark";
};

export function LabModelCreateDialog({
  baseModelCandidates,
  busy,
  defaultBenchmarkModel,
  initialName,
  onClose,
  onCreate,
  onManageModels,
  providerSettings,
}: {
  baseModelCandidates: BaseModelCandidate[];
  busy: boolean;
  defaultBenchmarkModel: ChatModelRef;
  initialName: string;
  onClose: () => void;
  onCreate: (input: LabModelCreateInput) => Promise<boolean>;
  onManageModels: () => void;
  providerSettings: ProviderSettings | null;
}) {
  const listedCandidates = useMemo(
    () => labModelCreateCandidates(baseModelCandidates),
    [baseModelCandidates],
  );
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState("");
  const [baseModelKey, setBaseModelKey] = useState("");
  const [purpose, setPurpose] = useState<"train" | "benchmark">("train");
  const benchmarkModelOptions = useMemo(
    () => benchmarkChatModelOptions(providerSettings, defaultBenchmarkModel),
    [defaultBenchmarkModel, providerSettings],
  );
  const [benchmarkModelValue, setBenchmarkModelValue] = useState(
    chatModelValue(defaultBenchmarkModel),
  );
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
      benchmarkModel: purpose === "benchmark"
        ? chatModelFromValue(benchmarkModelValue)
        : null,
      purpose,
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
        <fieldset className="labs-model-create-purpose">
          <legend>What do you want to do?</legend>
          <button
            className={purpose === "train" ? "selected" : undefined}
            type="button"
            onClick={() => setPurpose("train")}
          >
            <strong>Train a model</strong>
            <small>Create runs and trained Versions from your Tasksets.</small>
          </button>
          <button
            className={purpose === "benchmark" ? "selected" : undefined}
            type="button"
            onClick={() => setPurpose("benchmark")}
          >
            <strong>Benchmark a model</strong>
            <small>Create the Model, then configure a controlled evaluation.</small>
          </button>
        </fieldset>
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
        {purpose === "benchmark" ? (
          <label className="labs-model-create-field">
            <span>Model to benchmark</span>
            <select
              aria-label="Model to benchmark"
              value={benchmarkModelValue}
              onChange={(event) => setBenchmarkModelValue(event.target.value)}
            >
              {benchmarkModelOptions.map((group) => (
                <optgroup key={group.providerId} label={group.providerLabel}>
                  {group.models.map((model) => (
                    <option key={model.value} value={model.value}>
                      {model.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <small>
              Uses the same chat-provider catalog as the composer. The choice is
              pinned in the saved benchmark receipt.
            </small>
          </label>
        ) : (
          <div className="labs-model-create-field">
            <span>Starting model <small>Optional</small></span>
            <div className="labs-model-create-select-row">
              <DropdownSelect
                label="Starting model"
                value={baseModelKey}
                options={[
                  { value: "", label: "Choose later" },
                  ...listedCandidates.map((candidate) => ({
                    value: candidate.selectionKey,
                    label: `${candidate.label} · ${candidate.sourceLabel}${
                      candidate.available ? "" : " · Unavailable"
                    }`,
                    disabled: !candidate.available,
                  })),
                ]}
                onChange={setBaseModelKey}
              />
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
        )}
        {error ? (
          <div className="labs-rename-error" role="alert">{error}</div>
        ) : null}
        <footer>
          <button disabled={busy} type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            disabled={!normalizedName || busy}
            type="submit"
          >
            {busy
              ? "Creating…"
              : purpose === "benchmark"
              ? "Create and benchmark"
              : "Create model"}
          </button>
        </footer>
      </form>
    </AppDialog>
  );
}

type BenchmarkModelGroup = {
  providerId: ChatProvider;
  providerLabel: string;
  models: Array<{ label: string; value: string }>;
};

function benchmarkChatModelOptions(
  settings: ProviderSettings | null,
  selected: ChatModelRef,
): BenchmarkModelGroup[] {
  const providers = providerOptionsFromSettings(settings, {
    includeUnavailable: false,
  });
  const groups = providers.flatMap((provider) => {
    const models = modelOptionsForProvider(provider.value, settings).map(
      (model) => ({
        label: model.label,
        value: chatModelValue({
          providerId: provider.value,
          modelId: model.value,
        }),
      }),
    );
    return models.length
      ? [{ providerId: provider.value, providerLabel: provider.label, models }]
      : [];
  });
  const selectedValue = chatModelValue(selected);
  if (groups.some((group) => group.models.some((model) => model.value === selectedValue))) {
    return groups;
  }
  return [
    {
      providerId: selected.providerId,
      providerLabel: chatProviderLabel(selected.providerId, settings),
      models: [{ label: selected.modelId, value: selectedValue }],
    },
    ...groups,
  ];
}

function chatModelValue(model: ChatModelRef): string {
  return JSON.stringify([model.providerId, model.modelId]);
}

function chatModelFromValue(value: string): ChatModelRef | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !Array.isArray(parsed)
      || parsed.length !== 2
      || typeof parsed[0] !== "string"
      || typeof parsed[1] !== "string"
    ) {
      return null;
    }
    return {
      providerId: parsed[0] as ChatModelRef["providerId"],
      modelId: parsed[1],
    };
  } catch {
    return null;
  }
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
