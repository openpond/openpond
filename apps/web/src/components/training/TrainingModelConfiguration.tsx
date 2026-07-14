import { useEffect, useState } from "react";
import {
  DEFAULT_LOCAL_MODEL_CHAT_CONFIGURATION,
  LocalModelChatConfigurationSchema,
  type LocalModelChatConfiguration,
  type ModelArtifactLineage,
} from "@openpond/contracts";
import type { useTraining } from "../../hooks/useTraining";
import type { ShowAppToast } from "../../app/app-state";

type TrainingController = ReturnType<typeof useTraining>;

const PROFILE_DEFAULTS: Record<Exclude<LocalModelChatConfiguration["profile"], "custom">, LocalModelChatConfiguration> = {
  efficient: DEFAULT_LOCAL_MODEL_CHAT_CONFIGURATION,
  full_harness: LocalModelChatConfigurationSchema.parse({
    profile: "full_harness",
    systemPromptMode: "full_harness",
    contextWindowTokens: 4_096,
    maxOutputTokens: 256,
    temperature: 0.2,
    repetitionPenalty: 1.05,
    noRepeatNgramSize: 0,
    compaction: "when_needed",
    keepWarmSeconds: 300,
  }),
};

export function TrainingModelConfiguration({
  lineage,
  training,
  onToast,
}: {
  lineage: ModelArtifactLineage | null;
  training: TrainingController;
  onToast: ShowAppToast;
}) {
  const [draft, setDraft] = useState<LocalModelChatConfiguration>(
    lineage?.chatConfiguration ?? DEFAULT_LOCAL_MODEL_CHAT_CONFIGURATION,
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(lineage?.chatConfiguration ?? DEFAULT_LOCAL_MODEL_CHAT_CONFIGURATION);
  }, [lineage?.chatConfiguration, lineage?.id]);

  if (!lineage) {
    return <div className="training-run-placeholder">Chat configuration is available after an adapter is imported.</div>;
  }

  const saved = lineage.chatConfiguration;
  const dirty = JSON.stringify({ ...draft, updatedAt: null }) !== JSON.stringify({ ...saved, updatedAt: null });

  function patch(next: Partial<LocalModelChatConfiguration>) {
    setDraft((current) => LocalModelChatConfigurationSchema.parse({ ...current, ...next, profile: next.profile ?? "custom", updatedAt: current.updatedAt }));
  }

  function applyProfile(profile: LocalModelChatConfiguration["profile"]) {
    if (profile === "custom") {
      setDraft((current) => ({ ...current, profile: "custom" }));
      return;
    }
    setDraft({ ...PROFILE_DEFAULTS[profile], updatedAt: saved.updatedAt });
  }

  return (
    <form
      className="training-model-configuration"
      onSubmit={async (event) => {
        event.preventDefault();
        setSaving(true);
        const updated = await training.actions.updateModelConfiguration(lineage.id, draft);
        setSaving(false);
        onToast(updated ? "Configuration saved." : "Couldn’t save configuration.", updated ? "success" : "error");
      }}
    >
      <div className="training-configuration-fields">
        <label>
          <span>Chat profile</span>
          <select value={draft.profile} onChange={(event) => applyProfile(event.target.value as LocalModelChatConfiguration["profile"])}>
            <option value="efficient">Efficient</option>
            <option value="full_harness">Full harness</option>
            <option value="custom">Custom</option>
          </select>
        </label>
        <label>
          <span>System prompt</span>
          <select value={draft.systemPromptMode} onChange={(event) => patch({ systemPromptMode: event.target.value as LocalModelChatConfiguration["systemPromptMode"] })}>
            <option value="lean">Lean</option>
            <option value="full_harness">Full harness</option>
            <option value="custom">Custom</option>
          </select>
        </label>
        {draft.systemPromptMode === "custom" ? (
          <label className="wide">
            <span>Custom system prompt</span>
            <textarea value={draft.customSystemPrompt ?? ""} onChange={(event) => patch({ customSystemPrompt: event.target.value || null })} />
          </label>
        ) : null}
        <NumberField label="Context window" value={draft.contextWindowTokens} min={128} max={32_768} onChange={(value) => patch({ contextWindowTokens: value })} />
        <NumberField label="Maximum output" value={draft.maxOutputTokens} min={1} max={512} onChange={(value) => patch({ maxOutputTokens: value })} />
        <NumberField label="Temperature" value={draft.temperature} min={0} max={2} step={0.1} onChange={(value) => patch({ temperature: value })} />
        <NumberField label="Repetition penalty" value={draft.repetitionPenalty} min={0.5} max={2} step={0.05} onChange={(value) => patch({ repetitionPenalty: value })} />
        <NumberField label="No-repeat n-gram" value={draft.noRepeatNgramSize} min={0} max={10} onChange={(value) => patch({ noRepeatNgramSize: value })} />
        <label>
          <span>Compaction</span>
          <select value={draft.compaction} onChange={(event) => patch({ compaction: event.target.value as LocalModelChatConfiguration["compaction"] })}>
            <option value="when_needed">When needed</option>
            <option value="off">Off</option>
          </select>
        </label>
        <NumberField label="Keep warm" suffix="seconds" value={draft.keepWarmSeconds} min={0} max={3_600} onChange={(value) => patch({ keepWarmSeconds: value })} />
      </div>
      <div className="training-configuration-actions">
        <button className="training-button secondary" type="button" disabled={!dirty || saving || Boolean(training.busyAction)} onClick={() => setDraft(saved)}>Reset</button>
        <button className="training-button" type="submit" disabled={!dirty || saving || Boolean(training.busyAction)}>{saving ? "Saving…" : "Save configuration"}</button>
      </div>
    </form>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label>
      <span>{label}{suffix ? ` (${suffix})` : ""}</span>
      <input type="number" min={min} max={max} step={step} value={value} onChange={(event) => { const next = event.currentTarget.valueAsNumber; if (Number.isFinite(next)) onChange(next); }} />
    </label>
  );
}
