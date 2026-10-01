import {HumanRevokeLocalPublicationSchema,HumanLocalPublicationsReadSchema,HumanExportLocalRequestSchema,HumanShareLocalRequestSchema} from "@openpond/evals/human-review";
import {revokeLocalHumanPublication,shareLocalHumanEvidence,readLocalHumanPublicationRefs} from "./local-sharing.js";
import {exportLocalHumanEvidence} from "./local-export.js";
import { z } from "zod";
import { createHostedCandidateEvaluations } from "../training/hosted-candidate-evaluations.js";
import { createHostedExperimentTrainingHandoff } from "../training/experiment-training-handoff.js";
import { createHostedTrainingSetup } from "../training/hosted-training-setup.js";
import { createHostedTrainingRunDetail } from "../training/hosted-training-run-detail.js";
import { OpenPondTrainingProjectClient } from "openpond-sdk/training-projects";
import { createExecutionActivityService } from "../training/execution-activity.js";
import { readHostedExecutionActivity } from "../training/hosted-execution-activity.js";
import { createHostedHumanReviewBridge } from "./hosted-bridge.js";
import { createLocalHumanReviewRuntime } from "./runtime.js";
import type { createLocalExperimentService } from "../evaluations/local-experiment-service.js";
import type { createTrainingApi } from "../training/training-api.js";
import type { SqliteStore } from "../store/store.js";

/** Shared transports retain the active account/workspace authority at I/O. */
export function createReviewAndActivityTransport(deps: {
  store: SqliteStore;
  storeDir: string;
  localExperiments: ReturnType<typeof createLocalExperimentService>;
  actorId: () => Promise<string>;
  teamId: () => Promise<string>;
  resolveAccess: () => Promise<{apiBaseUrl:string;token:string}>;
  trainingRequest: ReturnType<typeof createTrainingApi>["request"];
  humanReview?: ReturnType<typeof createLocalHumanReviewRuntime>;
}): ReturnType<typeof createTrainingApi>["request"] {
  const local = deps.humanReview ?? createLocalHumanReviewRuntime(deps);
  const hosted = createHostedHumanReviewBridge({ resolveAccess: async () => ({ ...await deps.resolveAccess(), teamId: await deps.teamId() }) });
  const activity = createExecutionActivityService({ ...deps,
    authorizeProject: async (teamId, _actorId, projectId) => {
      const access = await deps.resolveAccess();
      await new OpenPondTrainingProjectClient({baseUrl:access.apiBaseUrl,apiKey:access.token,teamId}).get(projectId);
    },
    hosted: async (teamId,projectId) => readHostedExecutionActivity(await deps.resolveAccess(),teamId,projectId),
  });
  return async (action,payload,requestUrl,signal) => {
    if (action === "hosted_candidate_evaluation") {
      const body=z.object({teamId:z.string().min(1),id:z.string().min(1).max(200).optional(),action:z.enum(["options","save","read","prepare","run","cancel"]),query:z.object({afterId:z.string().optional(),projectId:z.string().optional()}).strict().optional(),command:z.unknown().optional()}).strict().parse(payload);
      const [teamId,actorId,access]=await Promise.all([deps.teamId(),deps.actorId(),deps.resolveAccess()]);
      if(body.teamId!==teamId)throw new Error("The active workspace changed. Reopen trained-version evaluation.");
      const client=createHostedCandidateEvaluations({teamId,actorId,access,currentIdentity:async()=>({teamId:await deps.teamId(),actorId:await deps.actorId()})});
      if(body.action==="options")return client.options(body.query??{});
      if(body.action==="save")return client.save(body.command as Parameters<typeof client.save>[0]);
      const id=z.string().min(1).parse(body.id);
      return body.action==="read"?client.read(id):client.control(id,body.action,body.command);
    }
    if (action === "hosted_training_policy") {
      const body=z.object({teamId:z.string().min(1),id:z.string().min(1).max(200),afterId:z.string().min(1).max(200).nullable().optional(),command:z.unknown().optional()}).strict().parse(payload);
      const [teamId,actorId,access]=await Promise.all([deps.teamId(),deps.actorId(),deps.resolveAccess()]);
      if(body.teamId!==teamId)throw new Error("The active workspace changed. Reopen this policy.");
      const setup=createHostedTrainingSetup({teamId,actorId,access,currentIdentity:async()=>({teamId:await deps.teamId(),actorId:await deps.actorId()})});
      if(body.command!==undefined){
        if(z.object({id:z.string()}).passthrough().parse(body.command).id!==body.id)throw new Error("This command belongs to another policy.");
        return setup.policyControl(body.command);
      }
      return setup.policyRead(body.id,body.afterId??undefined);
    }
    if (action === "hosted_training_setup") {
      const body = z.object({teamId:z.string().min(1),configurationId:z.string().min(1).max(200).nullable().optional(),projectId:z.string().min(1).max(200).nullable().optional(),action:z.enum(["prepare","start","cancel","publish","attach"]).optional(),command:z.unknown().optional()}).strict().parse(payload);
      const [teamId,actorId,access] = await Promise.all([deps.teamId(),deps.actorId(),deps.resolveAccess()]);
      if (body.teamId !== teamId) throw new Error("The active workspace changed. Reopen training setup.");
      const setup=createHostedTrainingSetup({teamId,actorId,access,currentIdentity:async () => ({teamId:await deps.teamId(),actorId:await deps.actorId()})});
      if(body.action)return setup.perform(body.action,body.command);
      return setup.catalog({configurationId:z.string().min(1).parse(body.configurationId),projectId:body.projectId??null});
    }
    if (action === "experiment_training_handoff") {
      const body = z.object({teamId:z.string().min(1),executionId:z.string().min(1).max(200),passId:z.string().min(1).max(200).nullable()}).strict().parse(payload);
      const [teamId,actorId,access] = await Promise.all([deps.teamId(),deps.actorId(),deps.resolveAccess()]);
      if (body.teamId !== teamId) throw new Error("The active workspace changed. Reload this result.");
      return createHostedExperimentTrainingHandoff({teamId,actorId,access,currentIdentity:async () => ({teamId:await deps.teamId(),actorId:await deps.actorId()})}).read(body.executionId,body.passId);
    }
    if (action === "hosted_training_detail" || action === "hosted_training_control") {
      const body = z.object({teamId:z.string().min(1),jobId:z.string().min(1).max(200),action:z.enum(["start","retry","cancel"]).optional(),command:z.unknown().optional()}).strict().parse(payload);
      const [teamId,actorId,access] = await Promise.all([deps.teamId(),deps.actorId(),deps.resolveAccess()]);
      if (body.teamId !== teamId) throw new Error("The active workspace changed. Reload this training run.");
      const detail = createHostedTrainingRunDetail({teamId,actorId,access,currentIdentity:async () => ({teamId:await deps.teamId(),actorId:await deps.actorId()})});
      return action === "hosted_training_detail" ? detail.read(body.jobId) : detail.control(body.jobId,z.enum(["start","retry","cancel"]).parse(body.action),body.command);
    }
    if(action === "execution_activity") return activity(payload);
    if(action !== "human_review") return deps.trainingRequest(action,payload,requestUrl,signal);
    const location=requestUrl?.searchParams.get("location")??"hosted";
    if(location === "local"){
      if(HumanRevokeLocalPublicationSchema.safeParse(payload).success)return revokeLocalHumanPublication({...deps,hosted},payload,signal);
      if(HumanExportLocalRequestSchema.safeParse(payload).success)return exportLocalHumanEvidence(deps,payload);
      if(HumanShareLocalRequestSchema.safeParse(payload).success)return shareLocalHumanEvidence({...deps,hosted},payload,signal);
      if(HumanLocalPublicationsReadSchema.safeParse(payload).success)return readLocalHumanPublicationRefs(deps,payload);
      return local.request(payload);
    }
    if(location === "hosted")return hosted.request(payload,signal);
    throw new Error("Choose a valid review execution location.");
  };
}
