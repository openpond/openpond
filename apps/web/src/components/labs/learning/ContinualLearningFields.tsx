export interface ContinualLearningFieldsValue {
  enabled: boolean;
  mode: "nightly" | "approved_count" | "interval";
  minimumTasks: string;
  localTime: string;
  timeZone: string;
}

export function defaultContinualLearningFields(): ContinualLearningFieldsValue {
  return { enabled: false, mode: "nightly", minimumTasks: "10", localTime: "20:00", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
}

export function ContinualLearningFields({ value, onChange }: { value: ContinualLearningFieldsValue; onChange: (value: ContinualLearningFieldsValue) => void }) {
  return <section className="continual-learning-fields">
    <label className="learning-inline-choice"><input type="checkbox" role="switch" aria-label="Continual learning" checked={value.enabled} onChange={event => onChange({ ...value, enabled: event.target.checked })} />Continual learning <small>{value.enabled ? "Continual learning" : "Default"}</small></label>
    {value.enabled ? <>
      <label>Run<select aria-label="Run continual learning" value={value.mode} onChange={event => onChange({ ...value, mode: event.target.value as ContinualLearningFieldsValue["mode"] })}><option value="nightly">Every night</option><option value="approved_count">On task amount</option>{value.mode === "interval" ? <option value="interval">Current interval</option> : null}</select></label>
      <div className="continual-learning-inputs"><label>{value.mode === "nightly" ? "At least" : "New tasks"}<input aria-label="Minimum approved tasks" type="number" min={1} max={10000} value={value.minimumTasks} onChange={event => onChange({ ...value, minimumTasks: event.target.value })} /></label>
      {value.mode === "nightly" ? <label>At<input aria-label="Nightly time" type="time" value={value.localTime} onChange={event => onChange({ ...value, localTime: event.target.value })} /></label> : null}</div>
      <small>Approved, unused training tasks{value.mode === "nightly" ? ` · ${value.timeZone}` : ""}</small>
    </> : null}
  </section>;
}
