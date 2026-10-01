import { routeProfileCandidateAdoption } from "../harness/experiment-profile-adoption-router.js";
import { createLocalExperimentsRuntime } from "./local-experiments-runtime.js";
import { createReviewAndActivityTransport } from "../human-review/integration.js";
import { createExperimentImprovementRuntime } from "../harness/experiment-improvement-runtime.js";
import { createLocalProfileGitCandidateAdoption } from "../harness/experiment-profile-git-adoption.js";
import {createExperimentImprovementPayload} from "../harness/experiment-improvement-payload.js";
import type {TurnDispatcherPort} from "../runtime/turns/ports.js";
import {createLocalHumanReviewRuntime} from "../human-review/runtime.js";

type ExperimentDeps = Parameters<typeof createLocalExperimentsRuntime>[0];
type ReviewDeps = Parameters<typeof createReviewAndActivityTransport>[0];
type ImprovementDeps = Parameters<typeof createExperimentImprovementRuntime>[0];

type CoordinatedEvaluationRuntime = ReturnType<typeof createLocalExperimentsRuntime> & {
  improvements: ReturnType<typeof createExperimentImprovementRuntime>;
  trainingPayload: ReturnType<typeof createReviewAndActivityTransport>;
  experimentImprovementPayload: ReturnType<typeof createExperimentImprovementPayload>;
  turnTools: Omit<ReturnType<typeof createExperimentImprovementRuntime>["tools"],"executeCandidateWorkspaceTool">;
  executeCandidateWorkspaceTool: ReturnType<typeof createExperimentImprovementRuntime>["tools"]["executeCandidateWorkspaceTool"];
};

/** The lazy evidence reader breaks the startup cycle without changing which
 * service owns ordinary Experiments or permitting a synthetic adoption. */
export function createCoordinatedEvaluationRuntime(deps: Omit<ExperimentDeps,"candidateOrigins"|"sendTurn"|"interruptSessionTurn"> & {
  sendTurn:TurnDispatcherPort["sendTurn"];
  interruptSessionTurn:Parameters<typeof createExperimentImprovementPayload>[0]["interruptSessionTurn"];
  trainingRequest: ReviewDeps["trainingRequest"];
  agentRuntime?: ImprovementDeps["agentRuntime"];
  loadAgentRuntime?: ImprovementDeps["loadAgentRuntime"];
}): CoordinatedEvaluationRuntime {
  let experiments: ReturnType<typeof createLocalExperimentsRuntime> | undefined;
  let review:ReturnType<typeof createLocalHumanReviewRuntime>|undefined;
  const humanReview=()=>{
    if(!experiments)throw new Error("The canonical local Experiment owner is not ready.");
    return review??=createLocalHumanReviewRuntime({...deps,localExperiments:experiments.localExperiments});
  };
  const localAdoption = createLocalProfileGitCandidateAdoption(deps);
  const adoption = routeProfileCandidateAdoption({...deps,local:localAdoption});
  const improvements = createExperimentImprovementRuntime({
    ...deps, ...adoption,humanReview,
    localExperiments: () => {
      if (!experiments) throw new Error("Experiment evidence is not ready.");
      return experiments.localExperiments;
    },
  });
  try {
    experiments = createLocalExperimentsRuntime({...deps,candidateOrigins:improvements.candidateOrigins});
    const trainingPayload = createReviewAndActivityTransport({...deps,localExperiments:experiments.localExperiments,humanReview:humanReview()});
    const experimentImprovementPayload=createExperimentImprovementPayload({...deps,runtime:improvements,localExperiments:()=>experiments!.localExperiments});
    const {executeCandidateWorkspaceTool,...turnTools} = improvements.tools;
    return {...experiments,improvements,trainingPayload,experimentImprovementPayload,turnTools,executeCandidateWorkspaceTool};
  } catch (error) {
    void Promise.allSettled([improvements.close(),...(experiments?[experiments.localExperiments.close()]:[])]);
    throw error;
  }
}
