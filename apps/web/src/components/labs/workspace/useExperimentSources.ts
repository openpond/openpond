import { useQuery } from "@tanstack/react-query";
import { contentHash } from "@openpond/harness";
import { LocalExperimentSourceChoicesSchema } from "@openpond/contracts";
import type { Inventory, WorkspaceApi } from "./workspace-api";
import type { ExperimentSetupDraft, ExperimentSetupDefinition } from "./EvaluationSetupState";

export function useExperimentSources(api:WorkspaceApi,inventory:Inventory|null,draft:ExperimentSetupDraft,existing:ExperimentSetupDefinition|null) {
  const local=useQuery({queryKey:["evaluation-workspace",api.key,"localSources"],enabled:api.location==="local",
    queryFn:async({signal})=>LocalExperimentSourceChoicesSchema.parse(await api.local("sourceChoices",{},signal))});
  const targets=inventory?.projects.projects.find(item=>item.id===api.projectId)?.content.targets??[];
  const selected=targets.find(item=>item.id===draft.targetId);
  const saved=existing?.request.policy;
  const agent=api.location==="local"?local.data?.harnesses.find(item=>item.id===draft.sourceId):undefined;
  const compatibleProfiles=local.data?.profiles.filter(item=>item.taskset.id===draft.release?.id&&item.taskset.contentHash===draft.release.contentHash)??[];
  const profile=api.location==="local"?compatibleProfiles.find(item=>item.id===draft.profileChoiceId
    ||!draft.profileChoiceId&&saved?.kind==="hosted_harness"&&item.profileRef.repositoryId===saved.profileRepositoryId
    &&item.profileRef.profileId===saved.source.profileId&&item.definitionHash===saved.source.definitionHash
    &&contentHash(item.harnessRelease)===contentHash(saved.source.harnessRelease)):undefined;
  const harnessSource=draft.mode==="model_harness"?(api.location==="local"?agent?.source:selected?.target.kind==="agent"?selected.target.source:undefined):undefined;
  const profileTarget=draft.mode==="model_harness_profile"&&selected?.target.kind==="harness"?selected.target:undefined;
  const unavailable=draft.mode==="model_harness"&&!harnessSource?"The exact Harness is unavailable or unsupported in this account, workspace and execution location. Choose an authorized released Harness.":
    draft.mode==="model_harness_profile"&&(api.location==="local"?!profile:!profileTarget)?"The exact Profile composition is unavailable or incompatible with this Dataset. Choose its compatible released Profile evaluation.":null;
  return {local,targets,selected,compatibleProfiles,profile,profileTarget,harnessSource,unavailable,saved};
}
