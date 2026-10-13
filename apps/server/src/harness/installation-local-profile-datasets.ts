import path from "node:path";
import {z} from "zod";
import {contentHash,ReleaseHashSchema,ReleaseIdSchema} from "@openpond/harness";
import {loadOpenPondProfileLibrary} from "@openpond/cloud";
import {createProfileExternalDatasetBinding,type ProfileExternalDatasetBinding,type ProfileEvaluationDefinition} from "@openpond/evals";
import {verifyExternalDatasetPackage} from "openpond-sdk/experiments";
import {createLocalDatasetService} from "../training/local-dataset-service.js";
import {readCachedTasksetPackage} from "../training/taskset-package-files.js";
import {localPackageGraders} from "../evaluations/local-experiment-admission.js";
import {resolveLocalProfileExperimentSource} from "../evaluations/local-experiment-profile-source.js";
import type {SqliteStore} from "../store/store.js";
import {compileLocalHarnessSource} from "./local-harness-workspace-service.js";
import {compiledCandidateExecutableIdentity} from "./experiment-candidate-equivalence.js";
import {profileEvaluationsForRelease} from "./local-profile-evaluation-runtime.js";
import type {ExternalDatasetProfileSelection,ProfileExternalDatasetResolver} from "./profile-external-dataset-admission.js";

export const InstallationLocalDatasetSelectionSchema=z.object({
  id:ReleaseIdSchema,revision:z.number().int().positive(),workspaceHash:ReleaseHashSchema,
  taskIds:z.array(ReleaseIdSchema).min(1).max(500),seed:z.string().trim().min(1).max(500).default("1"),
}).strict();
export type InstallationLocalDatasetSelection=z.infer<typeof InstallationLocalDatasetSelectionSchema>;
export type InstallationLocalDatasetBindingPreparation=(selection:InstallationLocalDatasetSelection,profile:ExternalDatasetProfileSelection,definition:ProfileEvaluationDefinition)=>Promise<ProfileExternalDatasetBinding>;

/** Local package hashes name bytes, not authority. Resolve their actual saved
 * workspace and installation owner before using the ordinary Profile runner. */
export function createInstallationLocalProfileDatasets(deps:{store:SqliteStore;storeDir:string;remote?:ProfileExternalDatasetResolver}) {
  const datasets=createLocalDatasetService({store:deps.store,home:deps.storeDir});
  async function profileAuthority(selected:ExternalDatasetProfileSelection) {
    if(selected.profileRef.source!=="local")throw new Error("Installation-local Datasets require an accepted local Profile.");
    const library=await loadOpenPondProfileLibrary();
    if(!library.profiles.some(entry=>contentHash(entry.ref)===contentHash(selected.profileRef)))throw new Error("The local Dataset's Profile is no longer in this installation's accepted library.");
    const runtime=await resolveLocalProfileExperimentSource(deps.store,selected.harnessRelease,selected.profileRef);
    const catalog=await profileEvaluationsForRelease({store:deps.store,ref:selected.profileRef,sourceRevision:selected.sourceRevision,harnessRelease:selected.harnessRelease});
    const compiled=await compileLocalHarnessSource({workspaceId:typeof runtime.release.agentSnapshot.metadata.workspaceId==="string"?runtime.release.agentSnapshot.metadata.workspaceId:runtime.release.workspaceId,sourceDir:path.join(runtime.release.bundlePath,"source")});
    if(compiled.harnessRelease.contentHash!==selected.harnessRelease.contentHash)throw new Error("The local Dataset's frozen Profile source changed.");
    return {catalog,protectedClosureHash:compiledCandidateExecutableIdentity(compiled).protectedClosureHash};
  }
  async function savedPackage(id:string,workspaceHash:string,taskIds:string[]) {
    const selected=await deps.store.readLocalDatasetProjection(id,taskIds,{workspaceHash});
    if(!selected||selected.record.ownerId!==await deps.store.localResourceOwnerId())throw new Error("The exact installation-local Dataset workspace is unavailable to this owner.");
    return {record:selected.record,packageValue:datasets.compile(selected.record,undefined,selected.sourceWorkspaceHash)};
  }
  const prepareBinding:InstallationLocalDatasetBindingPreparation=async(raw,selected,definition)=>{
    const selection=InstallationLocalDatasetSelectionSchema.parse(raw);
    const record=await datasets.readListing(selection.id,selection.revision);
    if(record.workspace.contentHash!==selection.workspaceHash)throw new Error("The selected local Dataset revision or workspace hash changed.");
    if(new Set(selection.taskIds).size!==selection.taskIds.length)throw new Error("Select each local Dataset task once.");
    const {package:value}=await datasets.packageDataset(selection.id,selection.revision,selection.taskIds);
    const tasks=selection.taskIds.map(id=>value.taskset.tasks.find(task=>task.id===id));
    if(tasks.some(task=>!task)||tasks.some(task=>task!.split!==tasks[0]!.split))throw new Error("Select existing local Dataset tasks from one exact split.");
    const {catalog,protectedClosureHash}=await profileAuthority(selected);
    if(!catalog.definitions.some(item=>contentHash(item)===contentHash(definition)))throw new Error("The local Dataset target differs from the accepted Profile definition.");
    const pins=localPackageGraders(value);
    return createProfileExternalDatasetBinding({schemaVersion:"openpond.profileExternalDatasetBinding.v1",
      dataset:{id:value.taskset.id,revision:value.taskset.revision,contentHash:value.taskset.contentHash},packageHash:value.contentHash,
      profileId:selected.profileRef.profileId,target:definition.target,declaredProfileCatalogHash:catalog.catalogHash,protectedProfileClosureHash:protectedClosureHash,
      split:tasks[0]!.split,population:selection.taskIds.map(taskId=>({taskId,seed:selection.seed,fixtureId:null})),
      evaluators:pins.map(pin=>({release:pin.release??{id:pin.id,revision:pin.version,contentHash:pin.contentHash},feedbackKey:pin.feedbackKey,
        configurationHash:contentHash({graderHash:pin.contentHash,mappings:[]}),output:"score",categories:[]})),
      fieldMappings:[],fieldMappingsHash:contentHash([]),environmentHash:contentHash(value.taskset.environment),
      privateDatasetClosureHash:contentHash(value.files.filter(file=>file.asset.visibility!=="policy").map(file=>file.asset)),criterion:definition.criterion});
  };
  const resolveExternalDataset:ProfileExternalDatasetResolver=async(binding,selected)=>{
    let cached;
    try {cached=await readCachedTasksetPackage(deps.storeDir,binding.packageHash);}
    catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    const source=cached?z.object({sourceTasksetId:ReleaseIdSchema,sourcePackageHash:ReleaseHashSchema}).passthrough().safeParse(cached.taskset.metadata):null;
    // A cloud package may be cached too. Only a real installation-local saved
    // record chooses this owner; cache metadata cannot grant local access.
    const local=source?.success?await deps.store.readLocalDatasetListing(source.data.sourceTasksetId):null;
    if(!cached||!source?.success||!local) {
      if(!deps.remote)throw new Error("This external Dataset has no installation-local owner.");
      return deps.remote(binding,selected);
    }
    const localSource=source.data,cachedHash=cached.contentHash,localOwnerId=local.ownerId;
    async function read() {
      const taskIds=[...new Set(binding.population.map(member=>member.taskId))];
      const {record,packageValue}=await savedPackage(localSource.sourceTasksetId,localSource.sourcePackageHash,taskIds);
      if(record.ownerId!==localOwnerId||packageValue.contentHash!==cachedHash)throw new Error("The cached Dataset differs from its exact saved local source.");
      const authority=await profileAuthority(selected);
      if(binding.profileId!==selected.profileRef.profileId||binding.declaredProfileCatalogHash!==authority.catalog.catalogHash||binding.protectedProfileClosureHash!==authority.protectedClosureHash)
        throw new Error("The local Dataset recipe changed its accepted Profile or protected evaluator closure.");
      return verifyExternalDatasetPackage({binding,packageValue,graders:localPackageGraders(packageValue)});
    }
    const packageValue=await read();
    return {binding,packageValue,authorize:async()=>{if(contentHash(await read())!==contentHash(packageValue))throw new Error("The local Dataset authority changed during execution.");}};
  };
  return {prepareBinding,resolveExternalDataset};
}
