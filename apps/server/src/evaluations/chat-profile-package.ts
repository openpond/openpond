import { contentHash } from "@openpond/harness";
import { profileEvaluationsForRelease } from "../harness/local-profile-evaluation-runtime.js";
import { loadLocalProfileEvaluationTaskset } from "../harness/local-profile-evaluation-taskset.js";
import { admitProfileExternalDataset, type ProfileExternalDatasetResolver } from "../harness/profile-external-dataset-admission.js";
import type { SqliteStore } from "../store/store.js";
import type { LocalProfileEvaluationRun } from "../store/profile-evaluation-record.js";

/** Native releases and external Dataset bindings have different source owners.
 * A cache miss is not evidence that a completed Profile run lost its inputs. */
export async function loadChatProfilePackage(deps:{store:SqliteStore;home:string;resolveExternalDataset:ProfileExternalDatasetResolver},run:Pick<LocalProfileEvaluationRun,"manifest"|"profileRef">) {
  const source=run.manifest.profileEvaluation;
  if(!source)throw new Error("Saved experiment has no Profile source.");
  const selected={profileRef:run.profileRef,sourceRevision:source.sourceRevision,harnessRelease:source.harnessRelease};
  const loadCatalog=()=>profileEvaluationsForRelease({store:deps.store,ref:run.profileRef,...selected});
  let value;
  if(source.externalDatasetBinding) {
    const resolved=await deps.resolveExternalDataset(source.externalDatasetBinding,selected);
    await resolved.authorize();
    const admitted=await admitProfileExternalDataset({manifest:run.manifest,taskset:resolved.packageValue.taskset,selected,
      loadCatalog,resolveExternalDataset:deps.resolveExternalDataset});
    if(!admitted)throw new Error("The saved experiment's external Dataset owner is unavailable.");
    value=admitted.packageValue;
  } else {
    const catalog=await loadCatalog();
    const definition=catalog.definitions.find(definition=>definition.id===source.definitionId && contentHash(definition)===source.definitionHash);
    if(!definition)throw new Error("Saved experiment definition differs from its frozen Profile release.");
    value=await loadLocalProfileEvaluationTaskset({store:deps.store,storeDir:deps.home,definition,
      profileId:run.profileRef.profileId,harnessRelease:source.harnessRelease});
  }
  if(value.contentHash!==run.manifest.packageHash)throw new Error("Saved experiment Dataset differs from its frozen package pin.");
  return value;
}
