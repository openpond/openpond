import { contentHash } from "@openpond/harness";
import { gradeTaskEvidence } from "@openpond/evals/graders";
import { executeJavaScriptVerifierInWorker } from "@openpond/evals/javascript-verifier/node";
import { decodeTasksetPackageFile, type TasksetPackage } from "openpond-sdk/taskset-packages";
import type { LocalDatasetCheck, LocalDatasetRecord } from "@openpond/contracts";

/** Fixture checks use the evaluator's grading semantics; they cannot dispatch
 * target inference or an unbudgeted model judge. Unavailable evidence is saved. */
export async function checkLocalDatasetGraders(record: LocalDatasetRecord, value: TasksetPackage, signal?: AbortSignal, graderId?: string): Promise<LocalDatasetCheck> {
  const previous = graderId ? record.checks.find(check=>check.kind==="graders" && check.revision===record.workspace.draft.revision && check.workspaceHash===record.workspace.contentHash) : undefined;
  const retained = previous?.scopes?.filter(scope=>scope.graderId!==graderId && value.taskset.graders.some(grader=>grader.id===scope.graderId)) ?? [];
  const issues: LocalDatasetCheck["issues"] = previous?.issues.filter(issue=>issue.graderId && retained.some(scope=>scope.graderId===issue.graderId)) ?? [];
  const fixtures = record.workspace.draft.graderFixtures;
  let checked = retained.reduce((sum,scope)=>sum+scope.checked,0),total=retained.reduce((sum,scope)=>sum+scope.total,0);
  const scopes:NonNullable<LocalDatasetCheck["scopes"]>=[...retained];
  for (const grader of value.taskset.graders) {
    const selected=fixtures.filter(fixture=>!Array.isArray(fixture.metadata.graderIds) || fixture.metadata.graderIds.includes(grader.id));
    if(graderId && grader.id!==graderId) {
      if(!retained.some(scope=>scope.graderId===grader.id)) {
        total+=selected.length;
        scopes.push({graderId:grader.id,checked:0,total:selected.length,status:"unavailable"});
        issues.push({code:"grader_not_checked",message:"This grader has not been checked at the saved revision.",graderId:grader.id});
      }
      continue;
    }
    const start=checked,issueStart=issues.length;
    total+=selected.length;
    if (!selected.some(f => f.label === "positive") || !selected.some(f => f.label === "negative")) {
      issues.push({code:"examples_missing",message:"Add known-good and known-bad examples before claiming qualification.",graderId:grader.id});
    }
    for (const fixture of selected) {
      signal?.throwIfAborted();
      const task = value.taskset.tasks.find(t => t.id === fixture.taskId);
      if (!task) { issues.push({code:"fixture_task_missing",message:`Example ${fixture.id} references a missing task.`,graderId:grader.id,taskId:fixture.taskId}); continue; }
      try {
        const grade = await gradeTaskEvidence({task, graders:[grader], purpose:"fixture_calibration", signal,
          evidence:{output:fixture.output,runtimeEventRefs:[],artifactRefs:[],infrastructureError:fixture.infrastructureError},
          customVerifier: async ({grader,task,evidence}) => {
            if (grader.runtime === "sandbox_process") throw new Error("This fixture requires the qualified process verifier owner.");
            const file = value.files.find(f => f.asset.id === grader.verifierRef.id);
            if (!file || contentHash(file.asset) !== contentHash(grader.verifierRef)) throw new Error("The exact verifier source is missing.");
            const result = await executeJavaScriptVerifierInWorker({source:new TextDecoder("utf-8",{fatal:true}).decode(decodeTasksetPackageFile(file)),exportName:grader.exportName,runtime:grader.runtime,timeoutMs:grader.timeoutMs,signal,
              value:{task,attempt:evidence,input:task.input,expectedOutput:task.expectedOutput,output:evidence.output,artifacts:[],infrastructureError:fixture.infrastructureError}});
            return {score:result.score,passed:result.passed,rewardEligible:grader.rewardEligible,failureClass:null,feedback:[result.feedback],visibleEvidenceRefs:[],privilegedEvidenceRefs:result.evidenceRefs};
          }});
        if (grade.gradingStatus === "unscorable" && !fixture.infrastructureError || grade.gradingStatus === "pending") {
          issues.push({code:"grader_unavailable",message:grade.components.flatMap(c => c.feedback).join(" "),graderId:grader.id,taskId:task.id});
        } else {
          checked++;
          if (grade.passed !== fixture.expectedPassed || grade.rewardEligible !== fixture.expectedRewardEligible) issues.push({code:"example_mismatch",message:`Example ${fixture.id} did not match its expected pass/reward outcome.`,graderId:grader.id,taskId:task.id});
        }
      } catch (error) { issues.push({code:"grader_unavailable",message:error instanceof Error ? error.message : "Example check failed.",graderId:grader.id,taskId:task.id}); }
    }
    const ownIssues=issues.slice(issueStart);
    scopes.push({graderId:grader.id,checked:checked-start,total:selected.length,status:ownIssues.some(issue=>issue.code==="example_mismatch") ? "failed" : ownIssues.length ? "unavailable" : "passed"});
  }
  if (!value.taskset.graders.length) issues.push({code:"graders_missing",message:"No graders are configured."});
  return {kind:"graders",revision:record.workspace.draft.revision,workspaceHash:record.workspace.contentHash,
    status:issues.some(i => i.code === "example_mismatch") ? "failed" : issues.length ? "unavailable" : "passed",
    checked,total,scopes,issues,checkedAt:new Date().toISOString()};
}
