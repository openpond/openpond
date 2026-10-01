import {contentHash} from "@openpond/harness";
import {OpenPondTrainingProjectClient} from "openpond-sdk/training-projects";
import {createExperimentEvaluationScheduleService} from "./experiment-evaluation-schedule-service.js";
import {createExperimentEvaluationSchedulePayload} from "./experiment-evaluation-schedule-payload.js";
import {createLocalScheduledExperimentRuntime} from "./experiment-evaluation-schedule-runtime.js";
import {createScheduledDatasetReleaseReader} from "./experiment-evaluation-schedule-sources.js";
import {createAdvancedRefinerEvaluationPayload} from "../training/advanced-refiner-evaluation-payload.js";

type AdvancedDeps=Parameters<typeof createAdvancedRefinerEvaluationPayload>[0];
/** Owns scheduler lifetime and the no-dispatch authorization boundary. Both
 * advanced and scheduled controls retain the current account/Project scope. */
export function createCoordinatedQualificationRuntime(deps:Omit<AdvancedDeps,"authorizeProject">){
  const identity=async()=>({actorId:await deps.actorId(),teamId:await deps.teamId()});
  async function authorizeProject(id:string){
    const actor=await identity(),access=await deps.resolveAccess();
    const project=await new OpenPondTrainingProjectClient({baseUrl:access.apiBaseUrl,apiKey:access.token,teamId:actor.teamId}).get(id);
    if(project.archived||project.ownerScope!=="personal"||project.creatorUserId!==actor.actorId)
      throw new Error("Select a current Project owned by this account for evaluation coordination.");
    if(contentHash(await identity())!==contentHash(actor))throw new Error("Evaluation coordination authority changed.");
  }
  const schedules=createExperimentEvaluationScheduleService({storeDir:deps.storeDir,identity,
    authorize:async configuration=>{if(configuration.request.project)await authorizeProject(configuration.request.project.id);
      await deps.localExperiments().authorize({configuration});},
    runtime:createLocalScheduledExperimentRuntime(deps.localExperiments()),
    latestRelease:createScheduledDatasetReleaseReader({identity,resolveAccess:deps.resolveAccess}),
  });
  return {schedules,
    experimentEvaluationSchedulePayload:createExperimentEvaluationSchedulePayload({service:schedules,identity,authorizeProject}),
    advancedRefinerEvaluationPayload:createAdvancedRefinerEvaluationPayload({...deps,authorizeProject}),
  };
}

/** Runtime services otherwise close concurrently. Preserve the scheduler
 * guard store until every canonical evaluation and candidate has drained. */
export async function closeCoordinatedEvaluations(input:{
  schedules:Pick<ReturnType<typeof createExperimentEvaluationScheduleService>,"stop"|"close">;
  localExperiments:Pick<ReturnType<AdvancedDeps["localExperiments"]>,"close">;
  benchmarks:Pick<AdvancedDeps["benchmarks"],"close">;
  improvements:Pick<AdvancedDeps["runtime"],"close">;
  drainWork():unknown|Promise<unknown>;
  advancedBoundary:{close():unknown|Promise<unknown>};
}){
  const invoke = (close: () => unknown | Promise<unknown>) => Promise.resolve().then(close);
  const outcomes:PromiseSettledResult<unknown>[]=await Promise.allSettled([
    invoke(() => input.schedules.stop()),
  ]);
  outcomes.push(...await Promise.allSettled([
    invoke(() => input.localExperiments.close()),
    invoke(() => input.benchmarks.close()),
    invoke(() => input.drainWork()),
  ]));
  outcomes.push(...await Promise.allSettled([
    invoke(() => input.improvements.close()),
    invoke(() => input.schedules.close()),
    invoke(() => input.advancedBoundary.close()),
  ]));
  const failures=outcomes.filter((value):value is PromiseRejectedResult=>value.status==="rejected");
  if(failures.length)throw new AggregateError(failures.map(value=>value.reason),"Evaluation owners reported errors after shutdown cleanup.");
}
