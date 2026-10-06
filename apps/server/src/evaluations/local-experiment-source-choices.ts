import {assertNativeProfilePrivateGrading} from "./native-profile-private-grading.js";
import type { ProfileOriginAuthority } from "./local-experiment-profile-origin.js";
import { z } from "zod";
import { DatasetPopulationPageSchema } from "openpond-sdk/dataset-workspaces";
import { validateTasksetPackage, type TasksetPackage } from "openpond-sdk/taskset-packages";
import type { ProfileEvaluationDefinition } from "@openpond/evals";
import { localPackageGraders } from "./local-experiment-admission.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { contentHash, createHarnessSourcePackage } from "@openpond/harness";
import { loadOpenPondProfileLibrary } from "@openpond/cloud";
import { LocalExperimentSourceChoicesSchema, type OpenPondProfileRef, type LocalExperimentSourceChoices } from "@openpond/contracts";
import type { StandaloneHarnessExperimentSource } from "@openpond/evals/experiments";
import type { HarnessStateStore } from "../store/harness-state-store.js";
import { authorizeLocalExperimentSource } from "./local-experiment-source-authority.js";
import type { QualifiedLocalNativeHarness } from "./local-experiment-native.js";
import { profileEvaluationsForRelease } from "../harness/local-profile-evaluation-runtime.js";
import { resolveLocalProfileExperimentSource } from "./local-experiment-profile-source.js";
import type { createProfileEvaluationRunPreparationService } from "../harness/profile-evaluation-run-preparation.js";

type Workflows = Parameters<typeof createProfileEvaluationRunPreparationService>[0]["selectedWorkflows"];
/** Only an accepted persisted owner can make bytes available to this catalog.
 * Source hashes identify an immutable closure; they do not grant read access. */
export function createLocalExperimentSourceChoices(deps: {
  store: HarnessStateStore; native: QualifiedLocalNativeHarness; workflows: Workflows;
  remoteSource?: (workspace: Awaited<ReturnType<HarnessStateStore["getHarnessWorkspace"]>> & {}, release: {id:string;contentHash:string}) => Promise<StandaloneHarnessExperimentSource>;
  library?: typeof loadOpenPondProfileLibrary;
  originProfiles?:()=>Promise<Array<{ref:OpenPondProfileRef;name:string}>>;
  authorizeOrigin?:ProfileOriginAuthority;
  loadPackage:(definition:ProfileEvaluationDefinition,profileId:string,harnessRelease:{id:string;contentHash:string})=>Promise<TasksetPackage>;
}) {
  async function discover():Promise<{choices:LocalExperimentSourceChoices;packages:Map<string,TasksetPackage>}> {
    const packages=new Map<string,TasksetPackage>();
    const harnesses: LocalExperimentSourceChoices["harnesses"] = [];
    const profiles: LocalExperimentSourceChoices["profiles"] = [];
    for (const workspace of await deps.store.listHarnessWorkspaces()) {
      if (harnesses.length >= 100) break;
      for (const release of await deps.store.listHarnessReleaseRecords(workspace.id)) {
        if (harnesses.length >= 100) break;
        try {
          const reference = {id:release.harnessRelease.id,contentHash:release.harnessRelease.contentHash};
          let source: StandaloneHarnessExperimentSource;
          if (workspace.location === "local" && workspace.ownerScope.kind === "personal" && workspace.ownerScope.id === "desktop-personal") {
            const proposed={harnessRelease:reference,agentSnapshot:{id:release.agentSnapshot.id,contentHash:release.agentSnapshot.contentHash},sourcePackageHash:"0".repeat(64)};
            await authorizeLocalExperimentSource({store:deps.store,source:proposed});
            const files=new Map<string,Uint8Array>();
            for (const asset of release.harnessRelease.files) files.set(asset.path,await readFile(path.join(release.bundlePath,"source",...asset.path.split("/"))));
            const closure=createHarnessSourcePackage({agentSnapshot:release.agentSnapshot,harnessRelease:release.harnessRelease,files});
            source={...proposed,sourcePackageHash:closure.contentHash};
          } else {
            if (!deps.remoteSource) continue;
            source=await deps.remoteSource(workspace,reference);
          }
          await deps.native.resolve(source);
          harnesses.push({id:`harness-${source.harnessRelease.contentHash}`,name:workspace.name,source});
        } catch { /* Unavailable or unauthorized source never exposes its catalog entry. */ }
      }
    }
    const library=await (deps.library??loadOpenPondProfileLibrary)();
    for (const entry of [...library.profiles.filter(entry=>entry.ref.source==="local"),...await deps.originProfiles?.()??[]]) {
      if (profiles.length >= 100) continue;
      try {
        const workflows=await deps.workflows(entry.ref as OpenPondProfileRef);
        await resolveLocalProfileExperimentSource(deps.store,workflows.harnessRelease,entry.ref,deps.authorizeOrigin);
        const catalog=await profileEvaluationsForRelease({store:deps.store,ref:entry.ref,sourceRevision:workflows.sourceRevision,harnessRelease:workflows.harnessRelease});
        for (const definition of catalog.definitions) {
          if (profiles.length>=100) break;
          const value=validateTasksetPackage(await deps.loadPackage(definition,entry.ref.profileId,catalog.harnessRelease));
          if(value.taskset.id!==definition.tasksetRelease.id||value.taskset.contentHash!==definition.tasksetRelease.contentHash)throw new Error("Local Profile Dataset changed its exact binding.");
          if(value.taskset.tasks.length>10_000||value.taskset.environment.kind!=="text"||value.taskset.tools.some(tool=>!["work_exec","work_save_output"].includes(tool.name))||value.taskset.policy.connectedAppScopes.length
            ||value.taskset.capabilities.some(item=>item.required&&item.id!=="private-verifier"&&!(item.id==="tools"&&item.scopes.every(scope=>["work_exec","work_save_output"].includes(scope)&&value.taskset.tools.some(tool=>tool.name===scope))))||value.taskset.tasks.some(task=>task.artifactRefs.some(asset=>asset.visibility!=="policy"||asset.mediaType!=="application/pdf"||asset.sizeBytes>10000000)))continue;
          await assertNativeProfilePrivateGrading(value);
          const id=`local-profile-${contentHash([entry.ref,catalog.harnessRelease,definition.id])}`;
          packages.set(id,value);
          profiles.push({id:id,name:`${entry.name}, ${definition.label}`,
            profileRef:entry.ref,sourceRevision:catalog.sourceRevision,harnessRelease:catalog.harnessRelease,
            definitionId:definition.id,definitionHash:contentHash(definition),taskset:{id:value.taskset.id,revision:value.taskset.revision,contentHash:value.taskset.contentHash},taskCount:value.taskset.tasks.length,taskIds:definition.taskIds,seeds:definition.seeds});
        }
      } catch { /* Broken or unsupported local Profile is not selectable. */ }
    }
    return {choices:LocalExperimentSourceChoicesSchema.parse({location:"local",harnesses,profiles}),packages};
  }
  return {list:async()=> (await discover()).choices,packageByRelease:async(reference:{id:string;revision:number;contentHash:string})=> {
    const candidates=[...(await discover()).packages.values()].filter(value=>value.taskset.id===reference.id&&value.taskset.revision===reference.revision&&value.taskset.contentHash===reference.contentHash);
    if(new Set(candidates.map(value=>value.contentHash)).size>1)throw new Error("The local Dataset has conflicting immutable package closures.");
    return candidates[0]??null;
  },population:async(raw:unknown,teamId:string)=> {
    const query=z.object({id:z.string().min(1).max(240),view:z.enum(["ids","policy"]).default("ids"),afterId:z.string().optional(),limit:z.number().int().min(1).max(10_000).default(100)}).strict().parse(raw);
    if(query.view==="policy"&&query.limit>100)throw new Error("Local Dataset policy previews are bounded to100 tasks.");
    const discovered=await discover(),value=discovered.packages.get(query.id);
    if(!value)throw new Error("This exact local Profile Dataset is unavailable to the current account.");
    const sorted=[...value.taskset.tasks].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0),page=sorted.filter(task=>!query.afterId||task.id>query.afterId).slice(0,query.limit);
    const items=page.map(task=>({id:task.id,split:task.split,...(query.view==="policy"?{input:task.input,policyVisibleContext:task.policyVisibleContext,artifacts:[]}: {})}));
    const body={schemaVersion:"openpond.datasetPopulationPage.v1" as const,teamId,release:{id:value.taskset.id,revision:value.taskset.revision,contentHash:value.taskset.contentHash},view:query.view,
      taskCount:sorted.length,items,graders:localPackageGraders(value),nextCursor:page.length===query.limit&&sorted.some(task=>task.id>page.at(-1)!.id)?page.at(-1)!.id:null};
    return DatasetPopulationPageSchema.parse({...body,contentHash:contentHash(body)});
  }};
}
