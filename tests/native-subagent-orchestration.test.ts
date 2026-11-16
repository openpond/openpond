import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { updateConfig } from "@openpond/persistence";
import { ProviderSettingsSchema } from "@openpond/contracts/providers";
import { AppPreferencesSchema } from "@openpond/contracts/settings";
import { createTurnRunnerTestHarness, turnRunnerTestSession } from "./helpers/turn-runner-test-harness";

// Failure story: Claude's native Agent tool cannot launch GPT workers. Exercise
// its actual CLI/MCP boundary through child admission, model/permission routing,
// durable completion and reuse, rather than asserting catalog wiring alone.
test.skipIf(process.platform === "win32")("Claude launches and follows up a GPT child through OpenPond without substituting unavailable models", async () => {
  const home = await mkdtemp(join(tmpdir(), "openpond-native-subagents-"));
  const executable = join(home, "claude");
  await writeFile(executable, `#!${process.execPath}\n` + String.raw`
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const index = process.argv.indexOf('--mcp-config');
const server = index < 0 ? null : Object.values(JSON.parse(process.argv[index+1]).mcpServers)[0];
let requestId = 0, runId, lastResult, followedUp = false, permissionMode;
async function rpc(method, params = {}) {
  const response = await fetch(server.url, {method:'POST', headers:{...server.headers,'Content-Type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:++requestId,method,params})});
  const payload = await response.json();
  if(payload.error) throw new Error(payload.error.message);
  return payload.result;
}
async function call(name, args = {}) {
  const result = await rpc('tools/call', {name,arguments:args});
  if(result.isError) return {error:result.content[0].text};
  const parsed = JSON.parse(result.content[0].text);
  return parsed.data ?? parsed;
}
require('node:readline').createInterface({input:process.stdin}).on('line', async line => {
  const input = JSON.parse(line);
  if(input.type === 'control_request') {
    if(input.request.subtype === 'set_permission_mode') permissionMode = input.request.mode;
    send({type:'control_response',response:{subtype:'success',request_id:input.request_id,response:{}}}); return;
  }
  if(input.type !== 'user') return;
  try {
    const names = server ? (await rpc('tools/list')).tools.map(tool => tool.name) : [];
    const prompt = input.message.content.map(part=>part.text || '').join('\n');
    let result = lastResult ?? {names,permissionMode};
    if(names.includes('openpond_subagent_start')) {
      if(prompt.includes('Launch Claude child') && !lastResult?.claudeStarted) {
        result = {names,claudeStarted:await call('openpond_subagent_start', {roleId:'research',objective:'Inspect without editing.',modelRef:{providerId:'claude-code',modelId:'default'}})};
        result.joined = await call('openpond_subagent_join', {runId:result.claudeStarted.runId});
      } else if(prompt.includes('Follow up the child') && !followedUp) {
        followedUp = true;
        const status = await call('openpond_subagent_status');
        runId = status.runs[0].runId;
        const receipt = await call('openpond_subagent_followup', {runId,message:'Verify the second edge case.'});
        result.followup = receipt;
        result.joined = await call('openpond_subagent_join', {runId,inputId:receipt.taskInputId});
      } else if(!runId) {
        result.models = await call('openpond_subagent_models');
        result.unavailable = await call('openpond_subagent_start', {roleId:'research',objective:'Do not start',modelRef:{providerId:'codex',modelId:'missing-model'}});
        result.badEffort = await call('openpond_subagent_start', {roleId:'research',objective:'Do not start',modelRef:{providerId:'codex',modelId:'gpt-6.1-sol'},reasoningEffort:'max'});
        result.started = await call('openpond_subagent_start', {roleId:'research',objective:'Inspect the focused edge case.',modelRef:{providerId:'codex',modelId:'gpt-6.1-sol'},reasoningEffort:'high'});
        if(result.started.error) throw new Error(result.started.error);
        runId = result.started.runId;
        result.joined = await call('openpond_subagent_join', {runId});
      }
    }
    lastResult = result;
    send({type:'result',session_id:input.session_id,is_error:false,result:JSON.stringify(result)});
  } catch(error) { send({type:'result',session_id:input.session_id,is_error:true,errors:[String(error)]}); }
  send({type:'system',subtype:'session_state_changed',state:'idle'});
});
`, { mode: 0o700 });
  await updateConfig(home, config => ({ ...config, subagents: { enabled: true }, providers: {
    "claude-code": { enabled: true, binary_path: executable, source_home: home, native_mode: "bypassPermissions" },
  } }));
  const settings = ProviderSettingsSchema.parse({ statuses: {
    codex: { id: "codex", displayName: "Codex", enabled: true, available: true, modelIds: ["gpt-6.1-sol"], routing: { localRuntime: true } },
    "claude-code": { id: "claude-code", displayName: "Claude Code", enabled: true, available: true, modelIds: ["default"] },
  }, modelCaches: { codex: { providerId: "codex", models: [{ id: "gpt-6.1-sol", providerId: "codex", displayName: "GPT 6.1 Sol", source: "provider",
    capabilities: { toolCalling: true, reasoningEfforts: ["low", "medium", "high"] } }] } } });
  const session = turnRunnerTestSession({ provider: "claude-code", modelRef: { providerId: "claude-code", modelId: "default" },
    experience: "work", workspaceKind: "local_project", cwd: home });
  const internal = { ...session, id: "internal-chat", experience: "chat" as const };
  const harness: ReturnType<typeof createTurnRunnerTestHarness> = createTurnRunnerTestHarness({ sessions: [session, internal], dependencies: {
    storageHome: home, attachmentRootDir: home, loadProviderSettings: async () => settings,
    loadAppPreferences: async () => AppPreferencesSchema.parse({ subagents: { roles: [{ id: "research", toolPolicy: "read_only" }] } }),
    store: { listSubagentRuns: async (query = {}) => harness.state.subagentRuns.filter(run =>
      (!query.parentSessionId || run.parentSessionId === query.parentSessionId)
      && (!query.status || (Array.isArray(query.status) ? query.status : [query.status]).includes(run.status))) },
    createSession: async input => {
      const child = turnRunnerTestSession({ ...(input as Partial<import("@openpond/contracts").Session>), id: `child-${harness.state.sessions.size}` });
      harness.state.sessions.set(child.id, child);
      return child;
    },
    ensureCodexRuntime: async (child, input) => {
      expect(child.parentSessionId).toBe(session.id);
      expect(input).toMatchObject({ model: "gpt-6.1-sol", codexReasoningEffort: "high", sandbox: "read-only", approvalPolicy: "on-request" });
      expect(input.coordination!.tools.map(tool => tool.name)).not.toContain("openpond_subagent_start");
      return { threadId: `native-${child.id}`, cwd: home, permissionMode: "default", reasoningEffort: "high",
        client: { startTurn: async () => {
          const turn = harness.state.turns.findLast(turn => turn.sessionId === child.id)!;
          harness.state.events.push({ id: `answer-${turn.id}`, sessionId: child.id, turnId: turn.id, timestamp: new Date().toISOString(),
            name: "assistant.delta", source: "provider", output: "Focused GPT child result." });
          return { turnId: `native-${turn.id}` };
        }, waitForTurn: async () => {}, stopAndWait: async () => {} } as never,
      };
    },
  } });
  async function run(id: string, prompt: string) {
    const turn = await harness.runner.sendTurn(id, { prompt, modelRef: session.modelRef, approvalPolicy: "never", codexReasoningEffort: "low" });
    expect(turn.error).toBeNull();
    expect(turn.status).toBe("completed");
    return JSON.parse(harness.state.events.findLast(event => event.turnId === turn.id && event.name === "assistant.delta")!.output!);
  }
  try {
    const result = await run(session.id, "Launch the GPT research child.");
    await harness.dependencies.subagentQueue!.drain();
    await harness.dependencies.turnFollowUpQueue.drain();
    expect(result.models.models).toEqual(expect.arrayContaining([expect.objectContaining({ modelRef: { providerId: "codex", modelId: "gpt-6.1-sol" }, reasoningEfforts: ["low", "medium", "high"] })]));
    expect(result.unavailable.error).toContain("not available");
    expect(result.badEffort.error).toContain("does not advertise");
    expect(result.joined).toMatchObject({ runId: result.started.runId, modelRef: { providerId: "codex", modelId: "gpt-6.1-sol" } });
    expect(harness.state.subagentRuns[0]).toMatchObject({ status: "completed", report: { summary: "Focused GPT child result." } });
    expect(harness.state.subagentRuns).toHaveLength(1);
    const runId = harness.state.subagentRuns[0]!.id;
    const nativeSession = harness.state.sessions.get(session.id)!.nativeAgent!.sessionId;
    const followup = await run(session.id, "Follow up the child");
    await harness.dependencies.turnFollowUpQueue.drain();
    expect(followup.joined).toMatchObject({ runId });
    expect(harness.state.subagentRuns[0]).toMatchObject({ status: "completed" });
    expect(harness.state.subagentRuns).toHaveLength(1);
    expect(harness.state.turns.filter(turn => turn.sessionId === result.started.childSessionId)).toHaveLength(2);
    expect(harness.state.sessions.get(session.id)!.nativeAgent!.sessionId).toBe(nativeSession);
    expect(harness.state.events.some(event => event.name === "subagent.completed" && event.sessionId === session.id)).toBe(true);
    expect((await harness.runner.readTaskInbox(session.id)).inputs.some(input => input.kind === "result")).toBe(true);
    const claude = await run(session.id, "Launch Claude child");
    await harness.dependencies.subagentQueue!.drain();
    await harness.dependencies.turnFollowUpQueue.drain();
    const claudeRun = harness.state.subagentRuns.find(run => run.id === claude.claudeStarted.runId)!;
    expect(claudeRun.status).toBe("completed");
    const childResult = JSON.parse(claudeRun.report!.summary);
    expect(childResult.permissionMode).toBe("plan");
    expect(childResult.names).not.toContain("openpond_subagent_start");
    expect((await run(internal.id, "Inspect available tools")).names).not.toContain("openpond_subagent_start");
    await updateConfig(home, config => ({ ...config, subagents: { enabled: false } }));
    expect((await run(session.id, "Inspect available tools")).names).not.toContain("openpond_subagent_start");
    expect(harness.state.subagentRuns).toHaveLength(2);
  } finally { await harness.runner.close(); await rm(home, { recursive: true, force: true }); }
});
