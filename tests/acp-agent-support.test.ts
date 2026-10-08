import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { BootstrapPayload, ChatProvider, ProviderSettings, Session, Turn } from "@openpond/contracts";
import { createOpenPondServer } from "../apps/server/src/index.js";
import { readProvidersFile } from "../apps/server/src/openpond/provider-settings.js";
import { providersConfigPath } from "../apps/server/src/paths.js";
import { nativeAgentLaunch } from "../apps/server/src/runtime/native-agents/config.js";
import { providerOptionsFromSettings, modelRefForTurn } from "../apps/web/src/lib/app-models.js";
import { composerModelGroups, modelSelectionForGroup } from "../apps/web/src/components/chat/composer-model-options.js";

// A newly registered agent must survive configuration/server restart, use exact
// native choices, stream into retained history, and reject a changed instance.
it("runs a registered ACP command through setup, model selection, prompt and retained session loading", async () => {
  const home = await mkdtemp(join(tmpdir(), "openpond-general-acp-"));
  const script = join(home, "agent.cjs");
  const trace = join(home, "trace.jsonl");
  await writeFile(script, String.raw`
const fs=require('node:fs');
const send=m=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\n');
const catalog={models:{currentModelId:'vendor/default',availableModels:[{modelId:'vendor/default',name:'Default'},{modelId:'vendor/exact',name:'Exact'}]},modes:{currentModeId:'ask',availableModes:[{id:'ask',name:'Ask'},{id:'code',name:'Code'}]},configOptions:[{id:'effort',name:'Effort',type:'select',currentValue:'low',options:[{value:'low',name:'Low'},{value:'high',name:'High'}]}]};
catalog.configOptions.unshift({id:'model-choice',name:'Model',category:'model',type:'select',currentValue:'vendor/default',options:[{group:'vendor',name:'Vendor',options:[{value:'vendor/default',name:'Default'},{value:'vendor/exact',name:'Exact'}]}]}, {id:'mode-choice',name:'Mode',category:'mode',type:'select',currentValue:'ask',options:[{value:'ask',name:'Ask'},{value:'code',name:'Code'}]});
delete catalog.models;delete catalog.modes;
let authorized=false;
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);if(!r.method)return;
 fs.appendFileSync(process.env.ACP_TRACE,JSON.stringify({method:r.method,params:r.params,argument:process.argv[2],profile:process.env.ACP_PROFILE})+'\n');
 if(r.method==='initialize')return send({id:r.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true,mcpCapabilities:{http:false}},authMethods:[{id:'fixture_login',name:'Fixture login'}]}});
 if(r.method==='authenticate'){authorized=true;return send({id:r.id,result:{}});}
 if(r.method==='session/new'||r.method==='session/load'){
  if(!authorized)return send({id:r.id,error:{code:-32000,message:'Authentication required'}});
  if(r.params.mcpServers.length)process.exit(8);
  return send({id:r.id,result:{...catalog,sessionId:r.params.sessionId||'native-fixture'}});
 }
 if(r.method==='session/prompt'){
  send({method:'session/update',params:{sessionId:r.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'ACP fixture response'}}}});
  return send({id:r.id,result:{stopReason:'end_turn'}});
 }
 if(r.method==='session/set_config_option'){catalog.configOptions.find(option=>option.id===r.params.configId).currentValue=r.params.value;return send({id:r.id,result:{configOptions:catalog.configOptions}});}
 send({id:r.id,result:{}});
});`);
  const start = () => createOpenPondServer({ port: 0, storeDir: home, silent: true });
  let server = await start();
  async function api<T>(route: string, body?: unknown, method = body ? "POST" : "GET"): Promise<T> {
    const response = await fetch(`${server.url}${route}`, { method, headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error(`${route}: ${response.status} ${await response.text()}`);
    return await response.json() as T;
  }
  try {
    const added = await api<{ providerId: ChatProvider; settings: ProviderSettings }>("/v1/providers/acp-registry", { custom: { displayName: "Fixture ACP", command: process.execPath, args: [script, "argument with spaces;$(literal)"], env: { ACP_TRACE: trace, ACP_PROFILE: "profile A" } } });
    const id = added.providerId;
    expect(id).toMatch(/^acp:/);
    expect(added.settings.statuses[id]?.displayName).toBe("Fixture ACP");
    const groups = composerModelGroups({ currentProvider: "openpond", currentModelOptions: [], providerOptions: providerOptionsFromSettings(added.settings, { enabledOnly: true }), providerSettings: added.settings });
    expect(modelSelectionForGroup(groups.find(group => group.provider === id)!)).toEqual({ provider: id, model: "" });
    await api("/v1/providers", { providers: { [id]: { sourceHome: home } } }, "PATCH");
    const signedOut = await api<{ status: string; authMethods: Array<{ id: string }> }>(`/v1/providers/${id}/native-setup`, { action: "check" });
    expect(signedOut.status).toBe("needs_login");
    expect(signedOut.authMethods.map(method => method.id)).toEqual(["fixture_login"]);
    const loggedIn = await api<{ status: string }>(`/v1/providers/${id}/native-setup`, { action: "authenticate", authMethodId: "fixture_login" });
    expect(loggedIn.status).toBe("ready");
    const setup = await api<{ status: string; settings: ProviderSettings }>(`/v1/providers/${id}/native-setup`, { action: "check" });
    expect(setup.status).toBe("ready");
    expect(setup.settings.modelCaches[id]?.models.map(model => model.id)).toEqual(["vendor/default", "vendor/exact"]);
    expect(modelRefForTurn(id, "vendor/exact", setup.settings)).toEqual({ providerId: id, modelId: "vendor/exact" });
    await api("/v1/providers", { providers: { [id]: { nativeMode: "code", nativeOptions: { effort: "high" } } } }, "PATCH");
    const session = await api<Session>("/v1/sessions", { provider: id, cwd: home, title: "Registered ACP" });
    const first = await api<Turn>(`/v1/sessions/${session.id}/turns`, { prompt: "First request", modelRef: { providerId: id, modelId: "vendor/exact" } });
    expect(first.status).toBe("completed");
    const retained = await api<BootstrapPayload>("/v1/bootstrap?ensureProfile=0");
    expect(retained.sessions.find(entry => entry.id === session.id)?.nativeAgent).toMatchObject({ provider: id, sessionId: "native-fixture", cwd: home });
    expect(retained.events.filter(event => event.turnId === first.id && event.name === "assistant.delta").map(event => event.output).join("")).toBe("ACP fixture response");
    expect(retained.events.some(event => event.sessionId === session.id && event.action === "native_capabilities")).toBe(true);
    await server.close(); server = await start();
    const saved = await readProvidersFile(providersConfigPath(home));
    expect(saved.providers[id]?.acp).toMatchObject({ command: process.execPath, args: [script, "argument with spaces;$(literal)"], env: { ACP_PROFILE: "profile A" }, authMethodId: "fixture_login" });
    const second = await api<Turn>(`/v1/sessions/${session.id}/turns`, { prompt: "Continue retained session", modelRef: { providerId: id, modelId: "vendor/exact" } });
    expect(second.status).toBe("completed");
    const requests = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(requests.some(request => request.method === "session/load" && request.params.sessionId === "native-fixture")).toBe(true);
    expect(requests.some(request => request.method === "session/set_config_option" && request.params.configId === "model-choice" && request.params.value === "vendor/exact")).toBe(true);
    expect(requests.some(request => request.method === "session/set_config_option" && request.params.configId === "mode-choice" && request.params.value === "code")).toBe(true);
    expect(requests.some(request => request.method === "session/set_config_option" && request.params.value === "high")).toBe(true);
    expect(requests.every(request => request.argument === "argument with spaces;$(literal)" && request.profile === "profile A")).toBe(true);
    const original = nativeAgentLaunch(id as `acp:${string}`, saved.providers[id]);
    const changed = { ...saved.providers[id]!.acp!, env: { ...saved.providers[id]!.acp!.env, ACP_PROFILE: "profile B" } };
    expect(nativeAgentLaunch(id as `acp:${string}`, { ...saved.providers[id], acp: changed }).instanceId).not.toBe(original.instanceId);
    await api("/v1/providers", { providers: { [id]: { acp: changed } } }, "PATCH");
    const rejected = await api<Turn>(`/v1/sessions/${session.id}/turns`, { prompt: "Must not resume a different instance" });
    expect(rejected.status).toBe("failed");
    const removed = await api<{ settings: ProviderSettings }>("/v1/providers/acp-registry", { providerId: id }, "DELETE");
    expect(removed.settings.statuses[id]).toBeUndefined();
    expect((await api<BootstrapPayload>("/v1/bootstrap?ensureProfile=0")).sessions.some(entry => entry.id === session.id)).toBe(true);
  } finally { await server.close(); await rm(home, { recursive: true, force: true }); }
}, 60_000);
