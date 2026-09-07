import { useState } from "react";
import type { RewardFixtureAuthoringFields } from "openpond-sdk/learning";
import { AppDialog } from "../../dialogs/AppDialog";
import { LearningActions, LearningJsonField } from "./LearningFields";

export function RewardFixturesEditor({ fixtures, onChange }: { fixtures: RewardFixtureAuthoringFields[]; onChange: (fixtures: RewardFixtureAuthoringFields[]) => void }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = fixtures.find(fixture => fixture.id === selectedId);
  function patch(update: Partial<RewardFixtureAuthoringFields>) { onChange(fixtures.map(fixture => fixture.id === selectedId ? { ...fixture, ...update } : fixture)); }
  function add() {
    const id = `fixture-${crypto.randomUUID()}`;
    onChange([...fixtures, { id, name: `Example ${fixtures.length + 1}`, input: "{}", output: "{}", expectedOutput: "{}", evaluatorContext: "",
      artifactRefs: [], runtimeEventRefs: [], infrastructureError: "", expectedStatus: "scored", minimumScore: "1", maximumScore: "1", expectedPassed: "true" }]);
    setSelectedId(id);
  }
  return <section aria-label="Reward fixtures">
    <h3>Fixtures</h3>
    <p>Add example outputs and the grades you expect, including answers this Reward should reject.</p>
    {fixtures.length ? <ul className="learning-list">{fixtures.map(fixture => <li key={fixture.id}>
      <div><strong>{fixture.name || "Unnamed fixture"}</strong><p>{fixture.expectedStatus === "scored" ? `Expected score ${fixture.minimumScore}–${fixture.maximumScore}` : `Expected ${fixture.expectedStatus}`}</p></div>
      <button type="button" className="training-button secondary" onClick={() => setSelectedId(fixture.id)}>Edit fixture</button>
      <button type="button" className="training-button secondary" onClick={() => onChange(fixtures.filter(value => value.id !== fixture.id))}>Remove</button>
    </li>)}</ul> : <p>No fixtures yet.</p>}
    <button type="button" className="training-button secondary" disabled={fixtures.length >= 50} onClick={add}>Add fixture</button>
    {selected ? <AppDialog ariaLabel="Edit Reward fixture" className="labs-rename-dialog labs-model-taskset-dialog learning-editor-dialog" backdropClassName="labs-rename-backdrop" onClose={() => setSelectedId(null)}>
      <div className="labs-flat-body labs-resource-page learning-workspace">
        <h2>Edit fixture</h2><p>Changes belong to this Reward draft. Use Save draft to retain unfinished input.</p>
        <label>Name<input maxLength={500} value={selected.name} onChange={event => patch({ name: event.target.value })} /></label>
        <LearningJsonField label="Task input" value={selected.input} onChange={input => patch({ input })} />
        <LearningJsonField label="Example output" value={selected.output} onChange={output => patch({ output })} />
        <LearningJsonField label="Expected answer (optional)" value={selected.expectedOutput} onChange={expectedOutput => patch({ expectedOutput })} />
        <label>Expected grading status<select value={selected.expectedStatus} onChange={event => patch({ expectedStatus: event.target.value as RewardFixtureAuthoringFields["expectedStatus"] })}>
          <option value="scored">Scored</option><option value="unavailable">Unavailable</option><option value="pending">Pending human review</option><option value="failed">Grader failed</option>
        </select></label>
        {selected.expectedStatus === "scored" ? <>
          <label>Minimum expected score<input type="number" step="any" value={selected.minimumScore} onChange={event => patch({ minimumScore: event.target.value })} /></label>
          <label>Maximum expected score<input type="number" step="any" value={selected.maximumScore} onChange={event => patch({ maximumScore: event.target.value })} /></label>
          <label>Expected pass result<select value={selected.expectedPassed} onChange={event => patch({ expectedPassed: event.target.value as RewardFixtureAuthoringFields["expectedPassed"] })}><option value="true">Passed</option><option value="false">Failed</option><option value="any">Either</option></select></label>
        </> : null}
        <details><summary>Additional evidence</summary>
          <LearningJsonField label="Evaluator context (optional)" value={selected.evaluatorContext} onChange={evaluatorContext => patch({ evaluatorContext })} />
          <label>Artifact references<textarea value={selected.artifactRefs.join("\n")} onChange={event => patch({ artifactRefs: event.target.value.split("\n") })} /><small>One reference per line.</small></label>
          <label>Runtime event references<textarea value={selected.runtimeEventRefs.join("\n")} onChange={event => patch({ runtimeEventRefs: event.target.value.split("\n") })} /><small>One reference per line.</small></label>
          <label>Infrastructure failure (optional)<input value={selected.infrastructureError} onChange={event => patch({ infrastructureError: event.target.value })} /></label>
        </details>
        <LearningActions><button type="button" className="training-button" onClick={() => setSelectedId(null)}>Done</button></LearningActions>
      </div>
    </AppDialog> : null}
  </section>;
}
