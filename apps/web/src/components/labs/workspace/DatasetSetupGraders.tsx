import { GraderFieldMappings } from "./GraderFieldMappings";
import type { DatasetPopulationPage } from "openpond-sdk/dataset-workspaces";
import type { ExperimentFieldMapping } from "openpond-sdk/experiments";
export type SelectedDatasetGrader = { id: string; version: string; contentHash: string; mappings: ExperimentFieldMapping[] };

export function DatasetSetupGraders({ graders, selected, onChange }: { graders: DatasetPopulationPage["graders"]; selected: SelectedDatasetGrader[]; onChange: (value: SelectedDatasetGrader[]) => void }) {
  return <section><h3>Graders and field mappings</h3><p>Select up to 100 exact released graders. Map Dataset and retained output fields when their schemas differ.</p>{graders.map(grader => {
    const selection = selected.find(item => item.id === grader.id);
    return <details key={grader.id}><summary><label><input type="checkbox" checked={Boolean(selection)} onChange={event => onChange(event.target.checked ? [...selected, { id: grader.id, version: grader.version, contentHash: grader.contentHash, mappings: [] }] : selected.filter(item => item.id !== grader.id))} /> {grader.feedbackKey} · Version {grader.version}</label></summary><p>{grader.release ? `${grader.release.id} · Revision ${grader.release.revision}` : "Dataset-owned grader"}</p><code>{grader.contentHash}</code>{selection ? <GraderFieldMappings value={selection.mappings} onChange={mappings => onChange(selected.map(item => item.id === grader.id ? { ...item, mappings } : item))} /> : null}</details>;
  })}</section>;
}
