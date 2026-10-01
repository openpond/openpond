import {promises as fs} from "node:fs";
import path from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {contentHash,sha256} from "@openpond/harness";
import {loadOpenPondProfileStateForRef,loadOpenPondProfileStateFromSource} from "@openpond/cloud";
import type {OpenPondProfileState} from "@openpond/contracts";
import type {ExperimentImprovementState} from "./experiment-improvement-state.js";
import type {CompiledLocalHarnessSource} from "./local-harness-workspace-service.js";
import {compileProfileHarnessSource} from "./local-harness-workspace-service.js";
import {isProfilePrivateEvaluationPath} from "./profile-source-bindings.js";
const exec=promisify(execFile);
export async function candidateGit(repoPath:string,args:string[],environment:NodeJS.ProcessEnv={}){const result=await exec("git",["-C",repoPath,...args],{encoding:"utf8",timeout:30000,maxBuffer:8*1024*1024,env:{...process.env,...environment}});return result.stdout.trim();}
export async function originalCandidateProfile(state:ExperimentImprovementState,loadProfile=loadOpenPondProfileStateForRef,allowRemoteSnapshot=false){
  if(state.profileRef.source!=="local"&&!allowRemoteSnapshot)throw new Error("This Git adapter requires the actual installed local Profile owner; hosted adoption needs its published-source owner.");
  const profile=await loadProfile(state.profileRef);
  if(profile.error||profile.mode!=="local"||profile.activeProfile!==state.profileRef.profileId||!profile.repoPath||!profile.sourcePath)throw new Error("The original Profile owner is unavailable.");
  const repo=await fs.realpath(profile.repoPath),source=await fs.realpath(profile.sourcePath),relative=path.relative(repo,source);
  if(relative.startsWith("..")||path.isAbsolute(relative))throw new Error("Profile source escapes its actual Git owner.");
  return{profile,repo,source,sourceRelative:relative};
}
export async function assertCandidateGitHead(repo:string,expected:string,clean=true){
  if(!/^[a-f0-9]{40}$/.test(expected)||await candidateGit(repo,["rev-parse","HEAD"])!==expected)throw new Error("The original Profile Git revision changed.");
  if(clean&&await candidateGit(repo,["status","--porcelain","--untracked-files=all"]))throw new Error("Commit or reconcile changes in the original Profile before this operation.");
}
export async function withCandidateProfileWorktree<T>(input:{storeDir:string;state:ExperimentImprovementState;commit:string;loadProfile?:typeof loadOpenPondProfileStateForRef;allowRemoteSnapshot?:boolean},action:(value:{root:string;profile:OpenPondProfileState;repo:string;source:string})=>Promise<T>){
  const original=await originalCandidateProfile(input.state,input.loadProfile,input.allowRemoteSnapshot),parent=path.join(input.storeDir,"library","harnesses","profile-candidate-staging");await fs.mkdir(parent,{recursive:true,mode:0o700});
  const root=await fs.mkdtemp(path.join(parent,"source-"));await fs.rmdir(root);await candidateGit(original.repo,["worktree","add","--detach",root,input.commit]);
  try{const profile=await loadOpenPondProfileStateFromSource({repoPath:root,profileId:input.state.profileRef.profileId});if(profile.error||!profile.sourcePath)throw new Error("The staged original Profile cannot be loaded.");return await action({root,profile,repo:original.repo,source:profile.sourcePath});}
  finally{await candidateGit(original.repo,["worktree","remove","--force",root]).catch(()=>undefined);await fs.rm(root,{recursive:true,force:true});}
}
function portable(value:string){if(!value||path.isAbsolute(value)||value.includes("\\")||value.split("/").some(part=>!part||part==="."||part===".."))throw new Error("Original Profile patch path is not contained.");return value;}
/** Compiler provenance maps selected component bytes back to their actual
 * original files. Overlapping public aliases must agree on every edit. */
export async function applyCandidateProfileSource(input:{source:string;state:ExperimentImprovementState;base:CompiledLocalHarnessSource;candidate:CompiledLocalHarnessSource;profile:OpenPondProfileState}){
  const bindings=input.base.manifest.metadata.profileSourceBindings;if(!Array.isArray(bindings))throw new Error("The original release needs compiler source bindings before candidate adoption.");
  const primary=input.state.component.path,component=input.state.component;
  const known=new Map(bindings.map(row=>{if(!row||typeof row!=="object"||typeof row.releasedPath!=="string"||typeof row.profileRelativePath!=="string")throw new Error("Original Profile source binding is invalid.");return[portable(row.releasedPath),portable(row.profileRelativePath)] as const;}));
  const generatedInstruction=component.kind==="instruction"&&primary==="instructions/system.md"&&input.base.manifest.metadata.profileInstructionSourcePath==="instructions/system.md"&&!known.has(primary);
  const primaryMapping=known.get(primary)??(generatedInstruction?"instructions/system.md":undefined),prefix=component.kind==="workflow"?`workflows/${component.workflowId}/`:component.kind==="agent"?primary.split("/").slice(0,2).join("/")+"/":path.posix.dirname(primary)+"/";
  let originalPrefix=primaryMapping?path.posix.dirname(primaryMapping)+"/":null;
  if(component.kind==="workflow"&&!primaryMapping)originalPrefix=prefix;
  if(component.kind==="agent"){const agent=input.profile.agents.find(row=>primary.startsWith(`agents/${row.id}/`));if(!agent)throw new Error("The selected Agent original source is unavailable.");const originalPath=portable(agent.path),stat=await fs.lstat(path.join(input.source,originalPath));originalPrefix=(stat.isDirectory()?originalPath:path.posix.dirname(originalPath))+"/";}
  const before=new Map(input.base.sourceFiles.map(file=>[file.path,file])),after=new Map(input.candidate.sourceFiles.map(file=>[file.path,file])),patches=new Map<string,{before:string|null;bytes:Uint8Array|null}>();
  for(const releasedPath of new Set([...before.keys(),...after.keys()])){
    const old=before.get(releasedPath),next=after.get(releasedPath);if(old?.asset.contentHash===next?.asset.contentHash)continue;
    if((old&&old.asset.visibility!=="policy")||(next&&next.asset.visibility!=="policy"))throw new Error("A candidate cannot change protected Profile source.");
    let originalPath=known.get(releasedPath)??(generatedInstruction&&releasedPath===primary?primaryMapping:undefined);
    if(!originalPath&&releasedPath.startsWith(prefix)&&originalPrefix)originalPath=originalPrefix+releasedPath.slice(prefix.length);
    // These are compiler outputs, never original source files. Recompilation
    // below checks their exact coherence against the edited actual packages.
    if(!originalPath&&releasedPath==="workflows/catalog.json"&&[...known.keys()].some(key=>/^workflows\/[^/]+\/(PROMPT\.md|ACTION\.json)$/.test(key)))continue;
    if(!originalPath&&releasedPath==="dependency-lock/profile-import.json")continue;
    if(!originalPath)throw new Error(`The selected component has no original Profile source mapping: ${releasedPath}`);
    originalPath=portable(originalPath);if(originalPath!==primaryMapping&&!(component.kind!=="instruction"&&originalPrefix&&originalPath.startsWith(originalPrefix)))throw new Error("Candidate patch changes a different original Profile component.");if(isProfilePrivateEvaluationPath(originalPath))throw new Error("Candidate patch crosses the protected Profile evaluation closure.");
    const prior=patches.get(originalPath),bytes=next?.bytes??null;
    if(prior&&(prior.before!==(old?.asset.contentHash??null)||contentHash(prior.bytes===null?null:Array.from(prior.bytes))!==contentHash(bytes===null?null:Array.from(bytes))))throw new Error("Public component aliases disagree on the original source edit.");
    patches.set(originalPath,{before:generatedInstruction&&releasedPath===primary?null:old?.asset.contentHash??null,bytes});
  }
  for(const [relative,patch] of patches){const target=path.join(input.source,...relative.split("/"));let nearest=path.dirname(target);while(!await fs.stat(nearest).catch(()=>null))nearest=path.dirname(nearest);const contained=path.relative(await fs.realpath(input.source),await fs.realpath(nearest));if(contained.startsWith("..")||path.isAbsolute(contained))throw new Error("Candidate patch escapes the staged Profile source.");
    const stat=await fs.lstat(target).catch(()=>null);if(stat?.isSymbolicLink()||stat&&!stat.isFile())throw new Error("Original source patch needs a regular file.");
    const existing=stat?await fs.readFile(target):null;if((existing?sha256(existing):null)!==patch.before)throw new Error("Original source bytes differ from the exact candidate baseline.");
    if(patch.bytes===null)await fs.rm(target);else{await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,patch.bytes,{mode:stat?.mode??0o600});}
  }
  return[...patches.keys()];
}
export function compileOriginalCandidateProfile(input:{storeDir:string;state:ExperimentImprovementState;profile:OpenPondProfileState;sourceRevision:string;base:CompiledLocalHarnessSource}){
  const repositoryId=input.base.manifest.metadata.profileRepositoryId;
  return compileProfileHarnessSource({storeDir:input.storeDir,workspaceId:input.state.ownerWorkspaceId,name:input.base.manifest.name,profile:input.profile,sourceRevision:input.sourceRevision,
    ...(typeof repositoryId==="string"?{repositoryId}: {})});
}
