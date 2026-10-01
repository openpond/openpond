import { z } from "zod";
import { ImmutableReleaseRefSchema } from "@openpond/harness";
import { ProfileEvaluationDefinitionSchema, ProfileEvaluationSuiteSchema,
  ProfileEvaluationComparisonSchema, ProfileEvaluationSuiteRunSchema, ProfileEvaluationReportSchema,
  TasksetRunManifestSchema, TasksetMetricResultSchema } from "@openpond/evals";
import { fetchConnectedJson } from "./connected-evidence-http.js";

const Id = z.string().trim().min(1).max(240);
export const ProfileEvaluationDiscoverySchema = z.object({
  profileRef:z.object({source:z.enum(["local","github","openpond_git"]),repositoryId:Id,profileId:Id}).strict(),
  sourceRevision:z.string().min(1).max(500),harnessRelease:ImmutableReleaseRefSchema,
  catalogHash:z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  definitions:z.array(ProfileEvaluationDefinitionSchema).max(1000),suites:z.array(ProfileEvaluationSuiteSchema).max(100),
  runs:z.array(z.object({profileRef:z.object({source:z.enum(["local","github","openpond_git"]),repositoryId:Id,profileId:Id}).strict(),
    manifest:TasksetRunManifestSchema,metric:TasksetMetricResultSchema,gradeRefs:z.array(ImmutableReleaseRefSchema),
    receiptRefs:z.array(ImmutableReleaseRefSchema),passRate:z.number().min(0).max(1),passed:z.boolean(),
    completedAt:z.iso.datetime(),contentHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).max(1000),
  comparisons:z.array(ProfileEvaluationComparisonSchema).max(1000),suiteRuns:z.array(ProfileEvaluationSuiteRunSchema).max(1000),
  reports:z.array(ProfileEvaluationReportSchema).max(1000),
}).strict();
export type ProfileEvaluationDiscovery = z.infer<typeof ProfileEvaluationDiscoverySchema>;
export const ProfileEvaluationDiscoveryRequestSchema=z.object({teamId:Id,profileRepositoryId:Id,
  trainingProjectId:Id.optional()}).strict();

/** Reads the existing source owner's receipts. No resource is copied and no
 * incomplete execution is turned into a synthetic rerunnable configuration. */
export class OpenPondProfileEvaluationDiscoveryClient {
  constructor(private readonly options:{baseUrl:string;apiKey:string;teamId:string;fetch?:typeof fetch}){
    const url=new URL(options.baseUrl);
    if(!["http:","https:"].includes(url.protocol)||url.username||url.password||url.search||url.hash||!options.apiKey.trim()||!options.teamId.trim())
      throw new Error("Profile discovery requires a scoped HTTP endpoint and owner credential.");
  }
  async read(input:{profileRepositoryId:string;trainingProjectId?:string},signal?:AbortSignal){
    const body=ProfileEvaluationDiscoveryRequestSchema.parse({...input,teamId:this.options.teamId});
    const {response,value}=await fetchConnectedJson(this.options.fetch??fetch,
      `${this.options.baseUrl.replace(/\/$/,"")}/v1/profile-evaluation-discovery`,
      {method:"POST",redirect:"error",headers:{Authorization:`Bearer ${this.options.apiKey}`,"X-OpenPond-Team-Id":this.options.teamId,"Content-Type":"application/json"},body:JSON.stringify(body),signal},
      (_status,_code,message)=>new Error(message));
    if(!response.ok)throw new Error("The released Profile evaluation owner is unavailable to this account and workspace.");
    const discovery=ProfileEvaluationDiscoverySchema.parse(value);
    if(discovery.profileRef.repositoryId!==body.profileRepositoryId)throw new Error("Profile discovery returned another source owner.");
    return discovery;
  }
}
