import { contentHash } from "@openpond/harness";
import type { ChatResourceSummary,LocalDatasetRecord } from "@openpond/contracts";

export function localGraderSummaries(record:LocalDatasetRecord):ChatResourceSummary[] {
  const draft=record.workspace.draft;
  const check=record.checks.find(check=>check.kind==="graders");
  return draft.graders.map(grader=>{
    const scope=check?.scopes?.find(scope=>scope.graderId===grader.id);
    const status=check && check.workspaceHash!==record.workspace.contentHash ? "Checks stale" : scope?.status ?? "Not tested";
    const fixtures=draft.graderFixtures.filter(fixture=>!Array.isArray(fixture.metadata.graderIds) || fixture.metadata.graderIds.includes(grader.id));
    return {kind:"grader",id:`grader-${contentHash([draft.id,grader.id]).slice(0,40)}`,revision:draft.revision,name:grader.label,
      datasetId:draft.id,datasetRevision:draft.revision,graderId:grader.id,graderType:grader.kind,state:status,
      description:grader.kind==="content" && typeof grader.config.operator==="string" ? grader.config.operator : `${grader.kind} grader · ${grader.version}`,
      checkState:scope ? `${scope.checked}/${scope.total} examples checked · ${status}` : status,
      rows:fixtures.slice(0,3).map(fixture=>({id:fixture.id,label:fixture.label,detail:JSON.stringify(fixture.output)}))};
  });
}
