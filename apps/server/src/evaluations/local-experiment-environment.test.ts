import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { contentHash, createHarnessSourcePackage } from "@openpond/harness";
import { createLearningTextAsset, sealLearningContent } from "@openpond/evals/learning";
import { createExperimentCaseService } from "./experiment-case-service.js";
import { ExperimentModelCaseSchema } from "./experiment-case-contract.js";
import { createLocalExperimentEnvironment } from "./local-experiment-environment.js";
import { authorizeLocalExperimentSource } from "./local-experiment-source-authority.js";
import { createLocalExperimentSourceChoices } from "./local-experiment-source-choices.js";
import { resolveStandaloneExperimentSource } from "../harness/standalone-experiment-source.js";
import { createLocalExperimentRemoteSourceLookup, createLocalExperimentRemoteSourceAuthority } from "./local-experiment-source-hosting.js";
import { createLocalHarnessWorkspace } from "../harness/local-harness-workspace-service.js";
import { SqliteStore } from "../store/store.js";

function preparedCase() {
  const asset = createLearningTextAsset({ path: "environment/controller.mjs", mediaType: "application/javascript", visibility: "host_private", text: `
export function create(v){return {state:v.initialState,observation:{ready:true}};}
export const reset=create;
export function step(v){v.state.source=v.action.arguments.source;return {state:v.state,observation:{submitted:true}};}
export function collect(v){return {state:v.state,observation:{passed:v.services.program.status==='completed'&&v.services.program.cases.every(x=>x===7)}};}
export function destroy(){return {state:{},observation:{}};}` });
  const inputSchema = { type: "object", properties: { source: { type: "string" } }, required: ["source"], additionalProperties: false };
  const definition = sealLearningContent({ schemaVersion: "openpond.javascriptEnvironment.v1", id: "private-local-world", revision: 1,
    module: asset.asset, tools: [{ name: "submit", description: "Submit code", sideEffect: "write", inputSchema, inputSchemaHash: contentHash(inputSchema), timeoutMs: 2000 }],
    maxSteps: 2, maxStateBytes: 8192, maxObservationBytes: 1024, operationTimeoutMs: 2000,
    executionServices: [{ id: "program", kind: "javascript.v1", operation: "collect", timeoutMs: 1000,
      source: { scope: "state", path: ["source"] }, cases: { scope: "initialState", path: ["cases"] }, exportName: "transform", maxCases: 2, maxResultBytes: 1024 }] });
  return ExperimentModelCaseSchema.parse({ kind: "model", id: "owned-local-case", taskId: "local-task", admissionHash: "a".repeat(64),
    model: { providerId: "openpond", modelId: "controlled", configurationHash: "b".repeat(64), maxOutputTokens: 64, messages: [] },
    instructions: "Submit a transform then answer.", input: { public: true }, policyVisibleContext: {}, timeoutMs: 10000,
    environment: { kind: "javascript", definition, asset, initialState: { marker: "PRIVATE_STATE_NEVER_POLICY", source: "", cases: [{ input: 7, expected: "PRIVATE_GOLD" }] }, seed: 0 } });
}

// Failure story: local prepared execution must not expose private state/source,
// bypass isolated service restrictions, or report cleanup before a child exits.
test("local declared services retain fresh private state and settle actual child cancellation", async () => {
  const owner = createLocalExperimentEnvironment();
  const request = preparedCase(), records: unknown[] = [];
  let code = "export function transform(value){return value;}", cancel: AbortController | null = null;
  let turns = 0;
  const cases = createExperimentCaseService({ executeProfile: async () => { throw new Error("No Profile authority"); },
    resolveEnvironment: async input => owner.resolve(input, async record => {
      records.push(record);
      if (cancel && record.operation === "collect" && record.status === "admitted") setTimeout(() => cancel?.abort(), 100);
    }),
    resolvePolicy: async () => async ({ messages }) => {
      expect(JSON.stringify(messages)).not.toContain("PRIVATE_STATE_NEVER_POLICY");
      expect(JSON.stringify(messages)).not.toContain("PRIVATE_GOLD");
      turns++;
      return turns % 2 ? { text: "", toolCalls: [{ id: "submit-once", name: "submit", arguments: { source: code } }] } : { text: "done", toolCalls: [] };
    } });
  try {
    const result = await cases.execute(request) as { status: string; environmentCleanupComplete: boolean; snapshot: { state: Record<string, unknown>; events: Array<{ operation: string; observation?: { passed?: boolean } }> } };
    expect(result).toMatchObject({ status: "completed", environmentCleanupComplete: true });
    expect(result.snapshot.state.marker).toBe("PRIVATE_STATE_NEVER_POLICY");
    expect(result.snapshot.events.find(event => event.operation === "collect")?.observation?.passed).toBe(true);
    expect(JSON.stringify(records)).not.toContain("PRIVATE_STATE_NEVER_POLICY");
    expect(JSON.stringify(records)).not.toContain("PRIVATE_GOLD");
    code = "import fs from 'node:fs';export function transform(){return fs.readFileSync('/etc/passwd','utf8');}";
    const denied = await cases.execute({ ...request, id: "denied-local-capability" }) as typeof result;
    expect(denied.snapshot.events.find(event => event.operation === "collect")?.observation?.passed).toBe(false);
    expect(denied.environmentCleanupComplete).toBe(true);
    code = "export function transform(){while(true){}}";
    const timed = await cases.execute({ ...request, id: "timed-local-child" }) as typeof result;
    expect(timed.snapshot.events.find(event => event.operation === "collect")?.observation?.passed).toBe(false);
    expect(timed.environmentCleanupComplete).toBe(true);
    cancel = new AbortController();
    const work = cases.execute({ ...request, id: "cancelled-local-child" });
    cancel.signal.addEventListener("abort", () => cases.cancel("cancelled-local-child"), { once: true });
    expect(await work).toMatchObject({ status: "cancelled", environmentCleanupComplete: true });
    expect(records).toContainEqual(expect.objectContaining({ operation: "destroy", status: "completed", childCleanupComplete: true }));
    const execute = owner.resolve(request, async record => { records.push(record); });
    const environment = request.environment;
    if (environment.kind !== "javascript") throw new Error("Expected private fixture");
    const input = { source: "substituted-source", operation: "create" as const, timeoutMs: 2000,
      value: { input: request.input, initialState: environment.initialState, seed: 0, state: {}, action: null } };
    await expect(execute(input)).rejects.toThrow("local_environment_source_mismatch");
  } finally { await cases.close(); }
}, 30000);

// Failure story: a locally cached remote source hash is not permission to read
// private Harness bytes or create a native session under a different owner.
test("native source admission authorizes persisted device ownership before resolving bytes", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "local-native-origin-")), store = new SqliteStore(home);
  try {
    const own = await createLocalHarnessWorkspace({ store, storeDir: home, id: "device-owned", ownerId: "desktop-personal", name: "Device owned" });
    const cached = await createLocalHarnessWorkspace({ store, storeDir: home, id: "remote-cache", ownerId: "foreign-actor", name: "Remote cache" });
    const source = (release: typeof own.release) => ({ harnessRelease: { id: release.harnessRelease.id, contentHash: release.harnessRelease.contentHash },
      agentSnapshot: { id: release.agentSnapshot.id, contentHash: release.agentSnapshot.contentHash }, sourcePackageHash: "a".repeat(64) });
    expect((await authorizeLocalExperimentSource({ store, source: source(own.release) })).id).toBe(own.workspace.id);
    await expect(authorizeLocalExperimentSource({ store, source: source(cached.release) })).rejects.toMatchObject({ code: "local_harness_origin_authority_missing" });
    await expect(authorizeLocalExperimentSource({ store, source: { ...source(own.release), harnessRelease: { ...source(own.release).harnessRelease, id: "substituted" } } })).rejects.toMatchObject({ code: "local_harness_source_unavailable" });
    const files=new Map<string,Uint8Array>();
    for(const file of cached.release.harnessRelease.files)files.set(file.path,await readFile(path.join(cached.release.bundlePath,"source",file.path)));
    const published=createHarnessSourcePackage({agentSnapshot:cached.release.agentSnapshot,harnessRelease:cached.release.harnessRelease,files});
    const ref={...source(cached.release),sourcePackageHash:published.contentHash};
    let reads=0,actor="foreign-actor";
    const authorizeRemote=createLocalExperimentRemoteSourceAuthority({resolveAccess:async()=>({apiBaseUrl:"https://authorized.test",token:"proof-token",teamId:"workspace",actorId:actor}),
      fetch:async(_url,init)=> {reads++;expect(new Headers(init?.headers).get("x-openpond-team-id")).toBe("workspace");return new Response(JSON.stringify(published),{status:200});}});
    expect((await authorizeLocalExperimentSource({store,source:ref,authorizeRemote})).id).toBe(cached.workspace.id);
    expect(reads).toBe(1);
    await expect(authorizeLocalExperimentSource({store,source:{...ref,sourcePackageHash:"f".repeat(64)},authorizeRemote})).rejects.toMatchObject({code:"local_harness_authorized_source_conflict"});
    actor="different-actor";
    await expect(authorizeLocalExperimentSource({store,source:ref,authorizeRemote})).rejects.toMatchObject({code:"local_harness_origin_access_denied"});
    expect(reads).toBe(2);
    const choices=createLocalExperimentSourceChoices({store,library:async()=>({lastUsed:null,profiles:[]}),
      workflows:async()=>{throw new Error("No accepted Profile exists in this fixture.");},loadPackage:async()=>{throw new Error("No private Profile package may be read.");},
      remoteSource:createLocalExperimentRemoteSourceLookup({resolveAccess:async()=>({apiBaseUrl:"https://authorized.test",token:"proof-token",teamId:"workspace",actorId:actor}),
        fetch:async()=>{throw new Error("A foreign cached source must be denied before remote bytes are read.");}}),
      native:{qualified:true,resolve:async source=>{await resolveStandaloneExperimentSource({store,source,authorizeWorkspace:async()=>{await authorizeLocalExperimentSource({store,source});}});},
        execute:async()=>{throw new Error("Catalog reads must never create a native turn.");}}});
    const catalog=await choices.list();
    expect(catalog.harnesses).toHaveLength(1);expect(catalog.harnesses[0]?.source.harnessRelease.contentHash).toBe(own.release.harnessRelease.contentHash);
    expect(JSON.stringify(catalog)).not.toContain(cached.workspace.name);
    expect(JSON.stringify(catalog)).not.toContain(own.release.bundlePath);

  } finally { await store.close(); await rm(home, { recursive: true, force: true }); }
});
