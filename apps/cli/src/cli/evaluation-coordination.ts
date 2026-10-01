import {AdvancedRefinerEvaluationSetupCommandSchema,OpenPondAdvancedRefinerEvaluationClient} from "openpond-sdk/advanced-refiner-evaluations";
import {ExperimentEvaluationScheduleCommandSchema,OpenPondExperimentEvaluationScheduleClient} from "openpond-sdk/experiment-evaluation-schedules";
import {optionString} from "./common";
import {evaluationCommandAccess,readEvaluationCommandInput} from "./evaluation-command-access";

/** The same reviewed command and current native owner are used by UI, SDK and
 * CLI. Opening/listing/preparing never creates replacement paid intent. */
export async function runEvaluationCoordinationCommand(kind:"schedule"|"refiner",options:Record<string,string|boolean>,rest:string[]){
  const [action,id]=rest,actorId=optionString(options,"actor");
  if(!actorId||!action||rest.length>2)throw new Error("Select --actor, --team and an evaluation command.");
  if(options.local!==true&&options.local!=="true")throw new Error("These evaluation owners currently run through the authenticated native bridge. Select --local --server-url with its loopback origin.");
  const access={...await evaluationCommandAccess(options),actorId,projectId:optionString(options,"project")||null};
  const raw=action==="request"?await readEvaluationCommandInput(options):action==="list"?(kind==="schedule"?{operation:action,...(optionString(options,"cursor")?{cursor:optionString(options,"cursor")}:{}),limit:Number(optionString(options,"limit")||50)}:{operation:action}):{operation:action,id};
  if((action==="request"||action==="list")&&id)throw new Error("This operation does not accept an additional resource id.");
  const signal=AbortSignal.timeout(60_000);
  const value=kind==="schedule"?await new OpenPondExperimentEvaluationScheduleClient(access).command(ExperimentEvaluationScheduleCommandSchema.parse(raw),signal):await new OpenPondAdvancedRefinerEvaluationClient(access).command(AdvancedRefinerEvaluationSetupCommandSchema.parse(raw),signal);
  console.log(JSON.stringify(value,null,2));
}
