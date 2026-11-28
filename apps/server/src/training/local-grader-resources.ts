import { contentHash } from "@openpond/harness";
import type { ChatResourceSummary,LocalDatasetRecord } from "@openpond/contracts";
import { TasksetDraftSchema } from "openpond-sdk/taskset-drafts";

export function applyLocalGraderDraft(
  draft: LocalDatasetRecord["workspace"]["draft"],
  payload: Record<string, unknown>,
) {
  const grader = TasksetDraftSchema.shape.graders.unwrap().element.parse(payload.grader);
  const index = draft.graders.findIndex(existing => existing.id === grader.id);
  const graders = draft.graders.filter(existing => existing.id !== grader.id);
  graders.splice(index < 0 ? graders.length : index, 0, grader);
  if (payload.fixtureScope !== "grader") {
    const fixtures = Array.isArray(payload.fixtures)
      ? TasksetDraftSchema.shape.graderFixtures.unwrap().parse(payload.fixtures)
      : draft.graderFixtures;
    return { grader, graders, fixtures };
  }
  const fixtures = draft.graderFixtures.flatMap(fixture => {
    const participants = fixture.metadata.graderIds;
    if (!Array.isArray(participants) || !participants.includes(grader.id)) return [fixture];
    const remaining = participants.filter(id => id !== grader.id);
    return remaining.length ? [{ ...fixture, metadata: { ...fixture.metadata, graderIds: remaining } }] : [];
  });
  const newFixtures = TasksetDraftSchema.shape.graderFixtures.unwrap().parse(payload.fixtures);
  const ids = new Set(fixtures.map(fixture => fixture.id));
  for (const fixture of newFixtures) {
    if (ids.has(fixture.id)) throw new Error("A proposed Grader fixture ID already exists in the Dataset revision.");
    ids.add(fixture.id);
    fixtures.push({ ...fixture, metadata: { ...fixture.metadata, graderIds: [grader.id] } });
  }
  return { grader, graders, fixtures };
}

export function localGraderSummaries(record:Pick<LocalDatasetRecord,"checks"> & {workspace:Pick<LocalDatasetRecord["workspace"],"draft"|"contentHash">}):ChatResourceSummary[] {
  const draft=record.workspace.draft;
  const check=record.checks.find(check=>check.kind==="graders");
  return draft.graders.map(grader=>{
    const scope=check?.scopes?.find(scope=>scope.graderId===grader.id);
    const status=check && check.workspaceHash!==record.workspace.contentHash ? "Checks stale" : scope?.status ?? "Not tested";
    const fixtures=draft.graderFixtures.filter(fixture=>!Array.isArray(fixture.metadata.graderIds) || fixture.metadata.graderIds.includes(grader.id));
    return {kind:"grader",id:`grader-${contentHash([draft.id,grader.id]).slice(0,40)}`,revision:draft.revision,name:grader.label,
      datasetId:draft.id,datasetRevision:draft.revision,graderId:grader.id,graderType:grader.kind,state:status,
      description:grader.kind==="content" && typeof grader.config.operator==="string" ? grader.config.operator : `${grader.kind} grader, ${grader.version}`,
      checkState:scope ? `${scope.checked}/${scope.total} examples checked, ${status}` : status,
      rows:fixtures.slice(0,3).map(fixture=>({id:fixture.id,label:fixture.label,detail:JSON.stringify(fixture.output)}))};
  });
}
