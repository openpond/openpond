import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { ClaudeCliClient } from "../src/acp/claude-cli-client.js";

// Resuming the implementer to acknowledge a review must not inherit its coding
// tools or bypass mode. Exercise the actual subprocess/control boundary.
it.skipIf(process.platform === "win32")("resumes a reporting-only acknowledgment without coding tools or bypass permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openpond-claude-report-only-"));
  const executable = join(directory, "claude");
  await writeFile(executable, `#!${process.execPath}\n` + String.raw`
const args = process.argv.slice(2);
if (!args.includes('--restricted') || !args.includes('--strict-mcp-config') || args[args.indexOf('--tools')+1] !== '' || args.includes('--allow-dangerously-skip-permissions') || !JSON.parse(args[args.indexOf('--settings')+1]).disableAllHooks || !args.includes('--resume')) process.exit(1);
const readline = require('node:readline');
const send = value => process.stdout.write(JSON.stringify(value)+'\n');
readline.createInterface({input:process.stdin}).on('line', line => {
 const value = JSON.parse(line);
 if (value.type === 'control_request') send({type:'control_response',response:{subtype:'success',request_id:value.request_id,response:{}}});
 if (value.type === 'user') {
   send({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'Acknowledged without edits'}}});
   send({type:'result',is_error:false}); send({type:'system',subtype:'session_state_changed',state:'idle'});
 }
});`, { mode: 0o700 });
  const client = new ClaudeCliClient({ command: executable, args: [], cwd: directory, reportingOnly: true, requestTimeoutMs: 2_000,
    onUpdate: async () => {}, onPermission: async () => ({ outcome: { outcome: "cancelled" } }) });
  const originalSessionId = randomUUID();
  try {
    const resumed = await client.loadSession(originalSessionId, directory);
    expect(resumed.sessionId).toBe(originalSessionId);
    await expect(client.setMode(originalSessionId, "bypassPermissions")).rejects.toThrow("Reporting-only");
    await expect(client.setMode(originalSessionId, "plan")).rejects.toThrow("Reporting-only");
    await expect(client.prompt(originalSessionId, [{ type: "text", text: "Acknowledge findings" }])).resolves.toEqual({ stopReason: "end_turn" });
  } finally { await client.stop(); await rm(directory, { recursive: true, force: true }); }
});

// A missing launch opt-in makes YOLO fail only after selection; enabling bypass
// at launch would silently skip approvals. Cover both fresh and resumed sessions.
it.skipIf(process.platform === "win32").each([false, true])("switches Claude permissions explicitly for resumed=%s", async (resume) => {
  const directory = await mkdtemp(join(tmpdir(), "openpond-claude-permissions-"));
  const executable = join(directory, "claude");
  await writeFile(executable, `#!${process.execPath}\n` + String.raw`
const readline = require('node:readline');
const send = value => process.stdout.write(JSON.stringify(value)+'\n');
const args = process.argv.slice(2);
if (args[args.indexOf('--add-dir') + 1] !== require('node:path').join(process.cwd(), 'attached project')) process.exit(1);
let mode = args.includes('--dangerously-skip-permissions') ? 'bypassPermissions' : 'manual';
const finish = () => { send({type:'result',is_error:false}); send({type:'system',subtype:'session_state_changed',state:'idle'}); };
readline.createInterface({input:process.stdin}).on('line', line => {
 const value = JSON.parse(line);
 if(value.type==='control_request') {
  const request = value.request;
  if(request.subtype==='set_permission_mode') {
   if(request.mode==='bypassPermissions' && !args.includes('--allow-dangerously-skip-permissions')) {
    send({type:'control_response',response:{subtype:'error',request_id:value.request_id,error:'Bypass was not enabled at launch'}});
    return;
   }
   mode=request.mode;
  }
  send({type:'control_response',response:{subtype:'success',request_id:value.request_id,response:{current_permission_mode:mode}}});
 }
 if(value.type==='user') {
  send({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:mode}}});
  if(mode==='bypassPermissions') finish();
  else send({type:'control_request',request_id:'permission',request:{subtype:'can_use_tool',tool_use_id:'tool',tool_name:'Write',input:{path:'fixture'}}});
 }
 if(value.type==='control_response' && value.response.request_id==='permission') finish();
});`, { mode: 0o700 });
  let approvals = 0;
  const observedModes: string[] = [];
  const client = new ClaudeCliClient({ command: executable, args: [], cwd: directory, requestTimeoutMs: 2_000,
    additionalDirectories: [join(directory, "attached project")],
    onUpdate: async (_id, value) => { if (value.sessionUpdate === "agent_message_chunk") observedModes.push(String((value.content as { text: string }).text)); },
    onPermission: async () => { approvals++; return { outcome: { outcome: "selected", optionId: "allow" } }; },
  });
  try {
    const session = resume ? await client.loadSession(randomUUID(), directory) : await client.createSession(directory);
    expect(session.modes?.currentModeId).toBe("manual");
    expect(session.modes?.availableModes.some((mode) => mode.id === "bypassPermissions")).toBe(true);
    const prompt = () => client.prompt(session.sessionId, [{ type: "text", text: "run" }]);
    await prompt();
    expect(approvals).toBe(1);
    await expect(client.setMode("foreign", "bypassPermissions")).rejects.toThrow("does not belong");
    await expect(client.setMode(session.sessionId, "unsupported")).rejects.toThrow("Unsupported");
    await client.setMode(session.sessionId, "bypassPermissions");
    await prompt();
    expect(approvals).toBe(1);
    await client.setMode(session.sessionId, "manual");
    await prompt();
    expect(approvals).toBe(2);
    expect(observedModes).toEqual(["manual", "bypassPermissions", "manual"]);
  } finally { await client.stop(); await rm(directory, { recursive: true, force: true }); }
});

// Native login stays outside OpenPond. This boundary catches cross-session replies,
// lost streamed updates, and permissions surviving a cancelled native CLI turn.
it.skipIf(process.platform === "win32")("settles native Claude control and permission exchanges without changing session ownership", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openpond-claude-control-"));
  const executable = join(directory, "claude");
  await writeFile(executable, `#!${process.execPath}\n` + String.raw`
const readline = require('node:readline');
const send = value => process.stdout.write(JSON.stringify(value)+'\n');
let session;
readline.createInterface({input:process.stdin}).on('line', line => {
 const value = JSON.parse(line);
 if(value.type==='control_request') {
  send({type:'control_response',response:{subtype:'success',request_id:value.request_id,response:{models:[{value:'haiku',displayName:'Haiku'},{value:'default',displayName:'Default',description:'Haiku · Native configured default'}]}}});
  if(value.request.subtype==='interrupt') { send({type:'result',session_id:session,is_error:true,errors:['interrupted']}); send({type:'system',subtype:'session_state_changed',state:'idle'}); }
 }
 if(value.type==='user') {
  session=value.session_id;
  if(value.message.content[0].text==='foreign-stream') { send({type:'stream_event',session_id:'foreign',event:{type:'content_block_delta',delta:{type:'text_delta',text:'must-not-leak'}}}); return; }
  send({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'streamed'}}});
  send({type:'control_request',request_id:'permission',request:{subtype:'can_use_tool',tool_use_id:'tool',tool_name:'Write',input:{path:'fixture'}}});
 }
});`, { mode: 0o700 });
  let requested!: () => void;
  const ready = new Promise<void>((resolve) => { requested = resolve; });
  let permissionAborted = false;
  const updates: string[] = [];
  const controller = new AbortController();
  const client = new ClaudeCliClient({ command: executable, args: [], cwd: directory, requestTimeoutMs: 2_000,
    onUpdate: async (_id, value) => { if (value.sessionUpdate === "agent_message_chunk") updates.push(String((value.content as { text: string }).text)); },
    onPermission: async (_request, signal) => { requested(); signal.addEventListener("abort", () => { permissionAborted = true; }); return new Promise(() => undefined); },
  });
  try {
    const session = await client.createSession(directory);
    expect(session.models?.availableModels[0]?.modelId).toBe("haiku");
    // Resolving the default's displayed identity must preserve its routing alias.
    expect(session.models?.currentModelId).toBe("default");
    expect(session.models?.availableModels.map((model) => model.modelId)).toEqual(["haiku", "default"]);
    await expect(client.setModel("foreign", "haiku")).rejects.toThrow("does not belong");
    await client.setModel(session.sessionId, "haiku");
    await expect(client.prompt("foreign", [{ type: "text", text: "ignored" }])).rejects.toThrow("does not belong");
    const prompt = client.prompt(session.sessionId, [{ type: "text", text: "run" }], controller.signal);
    await ready;
    await expect(client.prompt(session.sessionId, [{ type: "text", text: "duplicate" }])).rejects.toThrow("already active");
    controller.abort();
    expect(await prompt).toEqual({ stopReason: "cancelled" });
    expect(updates).toEqual(["streamed"]);
    expect(permissionAborted).toBe(true);
    await expect(client.prompt(session.sessionId, [{ type: "text", text: "foreign-stream" }])).rejects.toThrow("changed native session identity");
    expect(updates).not.toContain("must-not-leak");
  } finally { await client.stop(); await rm(directory, { recursive: true, force: true }); }
});
