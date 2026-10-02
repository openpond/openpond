import { describe, it, expect } from "vitest";
import { AcpClient } from "../src/acp/client.js";

// A provider process can send permissions while streaming and exiting. These tests
// protect session ownership and settlement, not the particular UI representation.
const agent = String.raw`
const readline = require('node:readline');
const send = message => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...message})+'\n');
let prompt; let counter=0;
readline.createInterface({input:process.stdin}).on('line', line=>{
 const request=JSON.parse(line);
 if(request.method==='initialize')send({id:request.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[]}});
 if(request.method==='session/new')send({id:request.id,result:{sessionId:'session-'+(++counter)}});
 if(request.method==='session/load'){
   send({method:'session/update',params:{sessionId:request.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'retained'}}}});
   send({id:request.id,result:{}});
 }
 if(request.method==='session/prompt'){
   prompt=request;
   if(request.params.prompt[0].text==='crash')return process.exit(9);
   send({method:'session/update',params:{sessionId:request.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'hello'}}}});
   send({id:'approval',method:'session/request_permission',params:{sessionId:request.params.sessionId,toolCall:{toolCallId:'tool-1',title:'Write file'},options:[{optionId:'yes',kind:'allow_once',name:'Allow once'}]}});
 }
 if(request.id==='approval' && request.result)send({id:prompt.id,result:{stopReason:request.result.outcome.outcome==='selected'?'end_turn':'cancelled'}});
 if(request.method==='session/cancel')send({id:prompt.id,result:{stopReason:'cancelled'}});
});`;
function client(options: Partial<ConstructorParameters<typeof AcpClient>[0]> = {}) {
  return new AcpClient({ command: process.execPath, args: ["-e", agent], cwd: process.cwd(), requestTimeoutMs: 2_000, ...options });
}

describe("ACP process and session boundary", () => {
  it("waits for retained updates, scopes prompts and accepts only advertised permission options", async () => {
    const updates: string[] = [];
    const value = client({ onUpdate: async (_session, update) => { await new Promise((resolve) => setTimeout(resolve, 5)); updates.push(String((update.content as { text: string }).text)); }, onPermission: async () => ({ outcome: { outcome: "selected", optionId: "yes" } }) });
    try {
      await value.loadSession("retained-1", process.cwd());
      expect(updates).toEqual(["retained"]);
      await expect(value.prompt("other-connection", [{ type: "text", text: "hello" }])).rejects.toThrow("does not belong");
      expect(await value.prompt("retained-1", [{ type: "text", text: "hello" }])).toEqual({ stopReason: "end_turn" });
      expect(updates).toEqual(["retained", "hello"]);
    } finally { await value.stop(); }
  });

  it("cancels an outstanding permission without allowing a late answer or concurrent turn", async () => {
    const controller = new AbortController();
    let requested!: () => void;
    const ready = new Promise<void>((resolve) => { requested = resolve; });
    let aborted = false;
    const value = client({ onPermission: async (_request, signal) => { requested(); signal.addEventListener("abort", () => { aborted = true; }); return new Promise(() => undefined); } });
    try {
      const session = await value.createSession(process.cwd());
      const running = value.prompt(session.sessionId, [{ type: "text", text: "hello" }], controller.signal);
      await ready;
      await expect(value.prompt(session.sessionId, [{ type: "text", text: "duplicate" }])).rejects.toThrow("already active");
      controller.abort();
      expect((await running).stopReason).toBe("cancelled");
      expect(aborted).toBe(true);
    } finally { await value.stop(); }
  });

  it("rejects active work when the provider exits and invalidates its session ownership", async () => {
    const value = client();
    try {
      const session = await value.createSession(process.cwd());
      await expect(value.prompt(session.sessionId, [{ type: "text", text: "crash" }])).rejects.toThrow("exited");
      await expect(value.prompt(session.sessionId, [{ type: "text", text: "retry" }])).rejects.toThrow("does not belong");
    } finally { await value.stop(); }
  });
});
