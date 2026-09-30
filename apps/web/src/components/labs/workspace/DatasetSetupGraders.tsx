import { GraderFieldMappings } from "./GraderFieldMappings";
import type { DatasetPopulationPage } from "openpond-sdk/dataset-workspaces";
import type { ExperimentFieldMapping } from "openpond-sdk/experiments";
import { groupDatasetGraders } from "openpond-sdk/experiments";
export type SelectedDatasetGrader = { id: string; version: string; contentHash: string; mappings: ExperimentFieldMapping[] };

export function DatasetSetupGraders({ graders, selected, onChange }: { graders: DatasetPopulationPage["graders"]; selected: SelectedDatasetGrader[]; onChange: (value: SelectedDatasetGrader[]) => void }) {
  return <section><h3>Graders and field mappings</h3><p>Select up to 100 exact released graders. Map Dataset and retained output fields when their schemas differ.</p>{groupDatasetGraders(graders).map(({ key, grader, aliases }) => {
    const isAlias = (item: SelectedDatasetGrader) => aliases.some(alias => alias.id === item.id && alias.version === item.version && alias.contentHash === item.contentHash);
    const selection = selected.find(isAlias);
    return <details key={key}><summary><label><input type="checkbox" checked={Boolean(selection)} onChange={event => onChange(event.target.checked ? [...selected, { id: grader.id, version: grader.version, contentHash: grader.contentHash, mappings: [] }] : selected.filter(item => !isAlias(item)))} /> {grader.feedbackKey} · Version {grader.release?.revision ?? grader.version}</label></summary><p>{grader.release ? `${grader.release.id} · Revision ${grader.release.revision}` : "Dataset-owned grader"}</p><code>{grader.release?.contentHash ?? grader.contentHash}</code><p>Package {aliases.length > 1 ? "aliases" : "grader"}: {aliases.map(alias => `${alias.id} (version ${alias.version}, ${alias.contentHash})`).join("; ")}</p>{selection ? <GraderFieldMappings value={selection.mappings} onChange={mappings => onChange(selected.map(item => isAlias(item) ? { ...item, mappings } : item))} /> : null}</details>;
  })}</section>;
}
