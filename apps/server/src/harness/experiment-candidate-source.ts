import { compiledCandidateExecutableIdentity } from "./experiment-candidate-equivalence.js";
import { parseProfileSkillMarkdown } from "@openpond/cloud";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { HarnessSourceManifestSchema, type HarnessSourceManifest } from "@openpond/contracts";
import { canonicalJson, contentHash, sha256, compileProfileWorkflowPackages } from "@openpond/harness";
import { LocalHarnessReleaseRecordSchema, type LocalHarnessReleaseRecord } from "../store/store-harness-release-record.js";
import { compileLocalHarnessSource, materializeLocalHarnessRelease } from "./local-harness-workspace-service.js";
import { listRegularFiles, mediaTypeForPath, resolveContainedRegularFile } from "./local-harness-workspace-files.js";

export type CandidateComponent = { kind: "skill" | "workflow" | "agent" | "instruction"; path: string; workflowId?: string };
export type CandidateSourcePartition = { sourceRoot: string; base: { id: string; contentHash: string; sourceRevision: string };
  component: CandidateComponent; writablePaths: string[]; publicManifest: HarnessSourceManifest; publicHashes: Record<string,string>;
  protectedHashes: Record<string,string>; contentHash: string };
function safe(value: string) { if (!value || path.isAbsolute(value) || value.includes("\\") || value.includes("\0") || value.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Candidate source path is not contained."); return value; }
const selected = (partition: Pick<CandidateSourcePartition,"writablePaths">, value: string) => partition.writablePaths.some(root => value === root || value.startsWith(`${root}/`));
function candidateRoot(storeDir: string, id: string) { return path.join(storeDir, "library", "harnesses", "experiment-candidates", contentHash(id)); }
async function verifiedBase(record: LocalHarnessReleaseRecord) {
  const base = LocalHarnessReleaseRecordSchema.parse(record), source = path.join(base.bundlePath, "source");
  const compiled = await compileLocalHarnessSource({workspaceId:base.agentSnapshot.metadata.workspaceId as string ?? base.workspaceId, sourceDir:source});
  if (compiled.sourceRevision !== base.sourceRevision || compiled.harnessRelease.contentHash !== base.harnessRelease.contentHash || compiled.agentSnapshot.contentHash !== base.agentSnapshot.contentHash)
    throw new Error("Candidate baseline source differs from the immutable released bytes.");
  return compiled;
}

/** Candidate Work receives public policy source only. Private verifier closure never enters its tree. */
export async function materializeExperimentCandidateSource(input: {storeDir:string; candidateId:string; base:LocalHarnessReleaseRecord; component:CandidateComponent}) {
  const compiled = await verifiedBase(input.base), component = {...input.component,path:safe(input.component.path)};
  const primary = compiled.manifest.files.find(file => file.path === component.path);
  if (!primary || primary.kind !== component.kind || primary.visibility !== "policy") throw new Error("Select a released policy component for candidate authoring.");
  if (component.kind === "workflow" && !component.workflowId) throw new Error("Select the exact Workflow within its released catalog.");
  const privateHashes = new Set(compiled.sourceFiles.filter(file => file.asset.visibility !== "policy").map(file => file.asset.contentHash));
  const publicFiles = compiled.sourceFiles.filter(file => file.asset.visibility === "policy" && !privateHashes.has(file.asset.contentHash));
  if (!publicFiles.some(file => file.path === component.path)) throw new Error("The selected component duplicates protected private source and cannot be disclosed.");
  const authoredWorkflowPath = component.kind === "workflow" ? `workflows/${safe(component.workflowId!)}` : null;
  const hasAuthoredWorkflow = authoredWorkflowPath && publicFiles.some(file=>file.path===`${authoredWorkflowPath}/PROMPT.md`||file.path===`${authoredWorkflowPath}/ACTION.json`);
  const writablePaths = hasAuthoredWorkflow ? [component.path,authoredWorkflowPath!] : component.kind === "agent" ? [component.path.split("/").slice(0,2).join("/")] : component.kind === "skill" ? [path.posix.dirname(component.path)] : [component.path];
  if(component.kind==="agent"&&(!component.path.startsWith("agents/")||component.path.split("/").length<3))throw new Error("Select the exact released Agent source prefix.");
  if (writablePaths.some(value => value === ".")) throw new Error("Candidate authoring needs a focused component source directory.");
  const publicSet = new Set(publicFiles.map(file => file.path));
  const publicManifest = HarnessSourceManifestSchema.parse({...compiled.manifest, files:compiled.manifest.files.filter(file => publicSet.has(file.path)),
    metadata:{...compiled.manifest.metadata,profileSourceBindings:bindings(compiled.manifest).filter(binding=>publicSet.has(binding.releasedPath)),experimentCandidate:true}});
  const root = candidateRoot(input.storeDir,input.candidateId), sourceRoot = path.join(root,"authoring"), temporary = `${root}.preparing-${randomUUID()}`;
  const body = {sourceRoot,base:{id:input.base.harnessRelease.id,contentHash:input.base.harnessRelease.contentHash,sourceRevision:input.base.sourceRevision},component,writablePaths,publicManifest,
    publicHashes:Object.fromEntries(publicFiles.map(file => [file.path,file.asset.contentHash])),
    protectedHashes:Object.fromEntries(compiled.sourceFiles.filter(file => !publicSet.has(file.path)).map(file => [file.path,file.asset.contentHash]))};
  const partition:CandidateSourcePartition = {...body,contentHash:contentHash(body)};
  try {
    await fs.mkdir(path.join(temporary,"authoring"),{recursive:true,mode:0o700});
    await fs.writeFile(path.join(temporary,"partition.json"),canonicalJson(partition),{mode:0o600});
    await fs.writeFile(path.join(temporary,"authoring","harness.json"),canonicalJson(publicManifest),{mode:0o400});
    for (const file of publicFiles) { const target = path.join(temporary,"authoring",...file.path.split("/")); await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700}); await fs.writeFile(target,file.bytes,{mode:selected(partition,file.path)?0o600:0o400}); }
    await fs.mkdir(path.dirname(root),{recursive:true,mode:0o700});
    try { await fs.rename(temporary,root); } catch(error) { const existing = await readExperimentCandidatePartition(input.storeDir,input.candidateId).catch(()=>null);
      if (!existing || existing.contentHash !== partition.contentHash) throw error; }
    return partition;
  } finally { await fs.rm(temporary,{recursive:true,force:true}); }
}
export async function readExperimentCandidatePartition(storeDir:string,id:string):Promise<CandidateSourcePartition> {
  const raw:CandidateSourcePartition = JSON.parse(await fs.readFile(path.join(candidateRoot(storeDir,id),"partition.json"),"utf8"));
  const {contentHash:hash,...body} = raw;
  if (contentHash(body)!==hash || raw.sourceRoot!==path.join(candidateRoot(storeDir,id),"authoring")) throw new Error("Candidate partition integrity failed.");
  HarnessSourceManifestSchema.parse(raw.publicManifest); return raw;
}
export async function writeManualCandidateInstructions(input:{storeDir:string;candidateId:string;expectedHash:string;text:string}) {
  if (Buffer.byteLength(input.text)>250_000) throw new Error("Manual instructions exceed the component size limit.");
  const partition = await readExperimentCandidatePartition(input.storeDir,input.candidateId);
  if (partition.component.kind === "agent") throw new Error("Manual instruction editing requires an instruction-bearing component; use ordinary Work tools for Agent code.");
  const file = await resolveContainedRegularFile(partition.sourceRoot,partition.component.path), bytes = await fs.readFile(file);
  if (sha256(bytes)!==input.expectedHash) throw new Error("Candidate instructions changed; reload before saving.");
  if (partition.component.kind === "workflow") {
    const value = JSON.parse(bytes.toString("utf8")); const workflow = value.workflows?.find((row:{id:string})=>row.id===partition.component.workflowId);
    if (!workflow || workflow.invocation?.kind!=="instructions") throw new Error("This Workflow does not expose manual instruction editing.");
    workflow.invocation.instructions=input.text;
    const prompt=`workflows/${partition.component.workflowId}/PROMPT.md`;
    if(partition.publicHashes[prompt]) {const promptPath=await resolveContainedRegularFile(partition.sourceRoot,prompt),original=await fs.readFile(promptPath,"utf8");const header=/^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(original)?.[0]??"";await fs.writeFile(promptPath,header+input.text);}
    await fs.writeFile(file,canonicalJson(value));
  } else await fs.writeFile(file,input.text);
  return {path:partition.component.path,contentHash:sha256(await fs.readFile(file))};
}
/** Freeze rehydrates private bytes only in server-owned compilation storage, never authoring storage. */
export async function freezeExperimentCandidateSource(input:{storeDir:string;candidateId:string;base:LocalHarnessReleaseRecord;workspaceId:string;createdAt:string}) {
  const partition = await readExperimentCandidatePartition(input.storeDir,input.candidateId), base = await verifiedBase(input.base);
  if (partition.base.contentHash!==input.base.harnessRelease.contentHash || partition.base.sourceRevision!==input.base.sourceRevision) throw new Error("Candidate baseline release mismatch.");
  const inventory = (await listRegularFiles(partition.sourceRoot)).filter(file=>file!=="harness.json");
  const manifestBytes = await fs.readFile(await resolveContainedRegularFile(partition.sourceRoot,"harness.json"),"utf8");
  if (contentHash(JSON.parse(manifestBytes))!==contentHash(partition.publicManifest)) throw new Error("Candidate authoring changed the protected source manifest.");
  const files = new Map<string,Buffer>();
  for (const file of inventory) { const bytes=await fs.readFile(await resolveContainedRegularFile(partition.sourceRoot,file));
    if (bytes.byteLength>10_000_000) throw new Error("Candidate source exceeds the bounded component file size.");
    if (!selected(partition,file) && sha256(bytes)!==partition.publicHashes[file]) throw new Error("Candidate changed source outside its selected component.");
    if (partition.protectedHashes[file]) throw new Error("Candidate attempted to introduce protected private source."); files.set(file,bytes); }
  for (const file of Object.keys(partition.publicHashes)) if (!files.has(file) && !selected(partition,file)) throw new Error("Candidate removed source outside its selected component.");
  // Compiler provenance, rather than matching hashes, identifies public aliases.
  for(const binding of bindings(base.manifest).filter(row=>selected(partition,row.releasedPath))) {
    for(const alias of bindings(base.manifest).filter(row=>row.profileRelativePath===binding.profileRelativePath)) {
      if(partition.protectedHashes[alias.releasedPath])throw new Error("A selected public file aliases protected source.");
      const bytes=files.get(binding.releasedPath);if(bytes)files.set(alias.releasedPath,bytes);else files.delete(alias.releasedPath);
    }
  }
  const changedAliases=new Set(bindings(base.manifest).filter(alias=>bindings(base.manifest).some(selectedBinding=>selected(partition,selectedBinding.releasedPath)&&selectedBinding.profileRelativePath===alias.profileRelativePath)).map(alias=>alias.releasedPath));
  const authoredPaths=[...files.keys()].filter(file=>/^workflows\/[^/]+\/(PROMPT\.md|ACTION\.json)$/.test(file));
  if(partition.component.kind==="workflow"&&authoredPaths.length) {
    const sourceFiles=new Map([...files].filter(([file])=>file.startsWith("workflows/")&&file!=="workflows/catalog.json"&&file!=="workflows/actions.json").map(([file,bytes])=>[file,bytes.toString("utf8")]));
    const actionValue=JSON.parse(files.get("workflows/actions.json")!.toString("utf8"));
    const generated=compileProfileWorkflowPackages({files:sourceFiles,skillPaths:new Set(base.manifest.files.filter(file=>file.kind==="skill").map(file=>file.path)),actionIds:new Set(actionValue.actions.map((row:{id:string})=>row.id))});
    files.set("workflows/catalog.json",Buffer.from(canonicalJson(generated.catalog)));
  }
  if (partition.component.kind === "workflow") {
    const original=JSON.parse(Buffer.from(base.sourceFiles.find(file=>file.path===partition.component.path)!.bytes).toString("utf8"));
    const candidate=JSON.parse(files.get(partition.component.path)!.toString("utf8"));
    const withoutSelected=(value:{workflows:{id:string}[]})=>({...value,workflows:value.workflows.filter(row=>row.id!==partition.component.workflowId)});
    if (contentHash(withoutSelected(original))!==contentHash(withoutSelected(candidate)) || candidate.workflows.filter((row:{id:string})=>row.id===partition.component.workflowId).length!==1)
      throw new Error("Candidate changed another Workflow or the protected catalog structure.");
  }
  const declarations = base.manifest.files.filter(file=>file.visibility!=="policy" || !selected(partition,file.path) || files.has(file.path));
  for (const file of inventory) if (!declarations.some(row=>row.path===file)) declarations.push({id:`candidate-asset-${contentHash(file).slice(0,24)}`,path:file,kind:partition.component.kind==="skill"?"skill_resource":"asset",
    parentId:partition.component.kind==="skill"?base.manifest.files.find(row=>row.path===partition.component.path)!.id:null,mediaType:mediaTypeForPath(file),visibility:"policy",portability:"portable"});
  const temporary=path.join(candidateRoot(input.storeDir,input.candidateId),`.freeze-${randomUUID()}`);
  try { await fs.mkdir(temporary,{mode:0o700});
    const authoringHash=contentHash([...files.entries()].map(([file,bytes])=>({path:file,contentHash:sha256(bytes)})));
    const profileSourceRevision=authoringHash.slice(0,40);
    for (const declaration of declarations) { const original=base.sourceFiles.find(file=>file.path===declaration.path);
      let bytes=selected(partition,declaration.path)||changedAliases.has(declaration.path)?files.get(declaration.path):original?.bytes;
      if(declaration.path==="dependency-lock/profile-import.json"&&bytes){const value=JSON.parse(Buffer.from(bytes).toString("utf8"));if(value.source!=="openpond.profile"||value.profileGitHead!==base.manifest.metadata.profileGitHead)throw new Error("Generated provenance differs from the baseline compiler.");bytes=Buffer.from(canonicalJson({...value,profileGitHead:profileSourceRevision}));}
      if (!bytes) throw new Error("Candidate source cannot replace its selected primary or protected closure.");
      const destination=path.join(temporary,...declaration.path.split("/"));await fs.mkdir(path.dirname(destination),{recursive:true,mode:0o700});await fs.writeFile(destination,bytes); }
    await fs.writeFile(path.join(temporary,"harness.json"),canonicalJson({...base.manifest,files:declarations,
      metadata:{...base.manifest.metadata,...(base.manifest.metadata.importedFrom==="openpond.profile"?{profileGitHead:profileSourceRevision}:{})}}));
    const compiled=await compileLocalHarnessSource({workspaceId:input.workspaceId,sourceDir:temporary});
    for(const declaration of compiled.manifest.files.filter(file=>file.kind==="skill")) {
      const parsed=parseProfileSkillMarkdown(Buffer.from(compiled.sourceFiles.find(file=>file.path===declaration.path)!.bytes).toString("utf8"));
      if(parsed.messages.length>0)throw new Error(`Candidate Skill is invalid: ${parsed.messages.join(" ")}`);
    }
    const changed=compiled.sourceFiles.filter(file=>file.asset.contentHash!==base.sourceFiles.find(original=>original.path===file.path)?.asset.contentHash).map(file=>({path:file.path,before:partition.publicHashes[file.path]??null,after:file.asset.contentHash}));
    const removed=base.sourceFiles.filter(file=>!compiled.sourceFiles.some(candidate=>candidate.path===file.path)).map(file=>({path:file.path,before:file.asset.contentHash,after:null}));
    const release=await materializeLocalHarnessRelease({storeDir:input.storeDir,workspaceId:input.workspaceId,compiled,createdAt:input.createdAt});
    return {release,diff:[...changed,...removed],authoringHash,profileSourceRevision,executableIdentity:compiledCandidateExecutableIdentity(compiled),partitionHash:partition.contentHash};
  } finally {await fs.rm(temporary,{recursive:true,force:true});}
}

function bindings(manifest:HarnessSourceManifest):Array<{releasedPath:string;profileRelativePath:string}> {
  const value=manifest.metadata.profileSourceBindings;if(value===undefined)return[];
  if(!Array.isArray(value))throw new Error("Profile source binding metadata is invalid.");
  return value.map(row=>{if(!row||typeof row!=="object"||typeof row.releasedPath!=="string"||typeof row.profileRelativePath!=="string")throw new Error("Profile source binding is invalid.");return{releasedPath:safe(row.releasedPath),profileRelativePath:safe(row.profileRelativePath)};});
}
