import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { ClaudeCliClient } from "../src/acp/claude-cli-client.js";

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
  send({type:'control_response',response:{subtype:'success',request_id:value.request_id,response:{models:[{value:'haiku',displayName:'Haiku'}]}}});
  if(value.request.subtype==='interrupt') send({type:'result',session_id:session,is_error:true,errors:['interrupted']});
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
