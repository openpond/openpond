import { useId, useState, type ReactNode } from "react";
import type { ExperimentSetupDraft } from "./EvaluationSetupState";

export type EvaluationProtocol = Pick<ExperimentSetupDraft, "temperature" | "topP" | "seed" | "outputTokens" | "prompt">;

export function EvaluationProtocolFields({
  draft, patch, supportsSampling, disabled, samplingUnavailable, seedHint,
}: {
  draft: EvaluationProtocol;
  patch: (value: Partial<EvaluationProtocol>) => void;
  supportsSampling: boolean;
  disabled?: boolean;
  samplingUnavailable?: string;
  seedHint?: string;
}) {
  const overrides = draft.temperature !== undefined || draft.topP !== undefined;
  const seedHintId = useId();
  return <>
    {supportsSampling || overrides || samplingUnavailable ? (
      <>
        <label>
          <input
            type="checkbox"
            checked={overrides}
            disabled={disabled || (!supportsSampling && !overrides)}
            onChange={(event) =>
              patch(event.target.checked ? { temperature: 0, topP: 1 } : { temperature: undefined, topP: undefined })
            }
          />
          Override sampling
        </label>
        {overrides ? (
          <>
            <label>
              Temperature
              <input type="number" min="0" max="2" step="0.1" disabled={disabled || !supportsSampling}
                value={draft.temperature === null ? "" : draft.temperature ?? 0}
                onChange={(event) => patch({ temperature: event.target.value === "" ? null : event.target.valueAsNumber })} />
            </label>
            <label>
              Top P
              <input type="number" min="0.01" max="1" step="0.01" disabled={disabled || !supportsSampling}
                value={draft.topP === null ? "" : draft.topP ?? 1}
                onChange={(event) => patch({ topP: event.target.value === "" ? null : event.target.valueAsNumber })} />
            </label>
          </>
        ) : null}
        {!supportsSampling && (overrides || samplingUnavailable) ?
          <p>{samplingUnavailable ?? "This model does not support sampling overrides. Clear the override to continue."}</p> : null}
      </>
    ) : null}
    <label>
      Maximum output tokens
      <input type="number" min="1" max="4096" disabled={disabled} value={draft.outputTokens ?? ""}
        onChange={(event) => patch({ outputTokens: event.target.value === "" ? null : event.target.valueAsNumber })} />
    </label>
    <div>
      <label>
        Environment seeds
        <input inputMode="text" value={draft.seed} disabled={disabled} aria-describedby={seedHintId}
          onChange={(event) => patch({ seed: event.target.value })} />
      </label>
      <small id={seedHintId}>{seedHint ?? "Separate seeds with commas. Unchanged existing membership keeps each original task and seed pair."}</small>
    </div>
    <label>
      System instructions
      <textarea value={draft.prompt} rows={6} disabled={disabled} onChange={(event) => patch({ prompt: event.target.value })} />
    </label>
  </>;
}

export function ExperimentAdvancedSettings({
  draft, patch, supportsSampling, profileSeeds, children,
}: {
  draft: ExperimentSetupDraft;
  patch: (value: Partial<ExperimentSetupDraft>) => void;
  supportsSampling: boolean;
  profileSeeds?: string[];
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(() => draft.mode !== "model" || Boolean(draft.localRuntime));
  const profile = draft.mode === "model_harness_profile";
  return (
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Advanced settings</summary>
      {profile ? (
        <>
          <p>
            Profile execution uses its exact released model configuration and evaluation seeds. Its
            execution owner prepares those pins.
          </p>
          {profileSeeds ? <p>Released seeds: {profileSeeds.join(", ")}</p> : null}
        </>
      ) : (
        <>
          <EvaluationProtocolFields draft={draft} patch={patch} supportsSampling={supportsSampling} />
          {draft.mode === "model_harness" ? (
            <p>
              Released Harness instructions are immutable; additional system instructions must be empty.
            </p>
          ) : null}
        </>
      )}
      {children}
    </details>
  );
}
