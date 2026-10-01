import type {ExperimentManifest,ExperimentResult} from '@openpond/evals/experiments';
import type {HumanComparisonSelections} from '@openpond/evals/human-review';
import type {ExperimentImprovementState} from 'openpond-sdk/experiment-improvements';
import type {ImprovementActor} from '../harness/experiment-improvement-service.js';
import type {createLocalHumanReviewRuntime} from './runtime.js';
/** Compose the existing canonical review owner. No alternate review store or
 * history, and no provider/scorer call occurs in this accepted-evidence join. */
export function createAcceptedHumanComparisonProjector(deps:{humanReview():ReturnType<typeof createLocalHumanReviewRuntime>;authorize(actor:ImprovementActor,state:ExperimentImprovementState):Promise<void>}){
 return async(actor:ImprovementActor,state:ExperimentImprovementState,selections:HumanComparisonSelections,baseline:{manifest:ExperimentManifest;result:ExperimentResult},candidate:{manifest:ExperimentManifest;result:ExperimentResult})=>{
  if(!state.projectId||state.actorId!==actor.actorId||state.teamId!==actor.teamId)throw new Error('human_comparison_owner_changed');
  await deps.authorize(actor,state);
  const result=await deps.humanReview().projectComparison({scope:actor.teamId,actorId:actor.actorId,projectId:state.projectId,selections,baseline,candidate});
  await deps.authorize(actor,state);return result;
 };
}
