import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { RuntimeEventSchema, SessionSchema, type RuntimeEvent } from "@openpond/contracts";
import { ClaudeCliClient } from "../packages/agent-runtime/src/acp/claude-cli-client.js";
import { nativeAgentEvent } from "../apps/server/src/runtime/native-agents/events.js";
import { buildChatMessages } from "../apps/web/src/lib/chat-messages.js";
import { IncrementalChatProjector } from "../apps/web/src/lib/incremental-chat-projector.js";

// Reproduce the deployment failure at the CLI-to-persisted-chat boundary. A reply
// must not finish the turn while jobs run, or discard follow-up tools/approvals.
// Stop and process failure must release the turn without leaving a running row.
it.skipIf(process.platform === "win32").each(["completed", "failed", "killed", "cancel", "crash"])("retains native background work through %s and its follow-up", async (mode) => {
  const directory = await mkdtemp(join(tmpdir(), "openpond-claude-background-"));
  const executable = join(directory, "claude");
  await writeFile(executable, `#!${process.execPath}\n` + String.raw`
const send = value => process.stdout.write(JSON.stringify(value)+'\n');
const state = state => send({type:'system',subtype:'session_state_changed',state});
const tasks = ids => send({type:'system',subtype:'background_tasks_changed',tasks:ids.map(task_id=>({task_id,task_type:'local_bash',description:task_id,ambient:task_id==='ambient'}))});
const task = (subtype, id, extra={}) => send({type:'system',subtype,task_id:id,tool_use_id:'tool-'+id,...extra});
const text = (id, value) => {
 send({type:'stream_event',event:{type:'message_start',message:{id,model:'claude-fixture'}}});
 send({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:value}}});
 send({type:'assistant',message:{id,content:[{type:'text',text:value}]}});
};
const result = (id, value) => {
 const message={type:'result',uuid:id,is_error:false,result:value,usage:{input_tokens:100,output_tokens:10}};
 send(message);send(message);state('idle');
};
let session, mode, firstDone=false, stopped=[];
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const value=JSON.parse(line);
 if(value.type==='control_request') {
  const request=value.request;
  send({type:'control_response',response:{subtype:'success',request_id:value.request_id,response:{}}});
  if(request.subtype==='stop_task') { stopped.push(request.task_id); task('task_updated',request.task_id,{patch:{status:'killed'}}); }
  if(request.subtype==='interrupt') {
   send({type:'system',subtype:'task_progress',task_id:'deploy',description:JSON.stringify(stopped)});
   tasks(['ambient']);state('idle');
  }
  if(request.subtype==='set_model' && request.model==='finish-first') {
   if(mode==='crash') {process.exit(1);return;}
   tasks(['check','ambient']);
   task('task_updated','deploy',{patch:{status:mode}});
   if(mode!=='killed') task('task_notification','deploy',{status:mode,summary:'Deploy '+mode});
   // A terminal patch can have no notification (TaskStop). Later model work is
   // still part of the original prompt, and requires its permission callback.
   state('running');
   send({type:'control_request',request_id:'followup',request:{subtype:'can_use_tool',tool_use_id:'read',tool_name:'Read',input:{file_path:'deploy.log'}}});
  }
  if(request.subtype==='set_model' && request.model==='finish-check') {
   tasks(['ambient']);task('task_updated','check',{patch:{status:'completed'}});
   task('task_notification','check',{status:'completed',summary:'Check completed'});
   state('running');text('final','All background work finished');result('final-result','All background work finished');
  }
  return;
 }
 if(value.type==='control_response' && value.response.request_id==='followup') {
  if(value.response.response?.behavior!=='allow') {process.exit(2);return;}
  send({type:'assistant',message:{id:'read',content:[{type:'tool_use',id:'read',name:'Read',input:{file_path:'deploy.log'}}]}});
  send({type:'user',message:{content:[{type:'tool_result',tool_use_id:'read',content:'Verified deploy output'}]}});
  text('followup','Deploy checked; waiting for remaining work');result('followup-result','Deploy checked; waiting for remaining work');
  firstDone=true;return;
 }
 if(value.type!=='user') return;
 session=value.session_id;mode=value.message.content[0].text;
 if(firstDone) {
  // Stale completion replayed into the following user prompt must stay fenced.
  send({type:'result',uuid:'final-result',is_error:false,result:'All background work finished'});
  state('running');text('next','Next request');result('next-result','Next request');return;
 }
 if(process.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS!=='1') process.exit(3);
 state('running');tasks(['deploy','check','ambient']);
 for(const id of ['deploy','check']) {
  send({type:'assistant',message:{id:'launch-'+id,content:[{type:'tool_use',id:'tool-'+id,name:'Bash',input:{command:'run-'+id,run_in_background:true}}]}});
  task('task_started',id,{description:id,is_backgrounded:true});
  send({type:'user',message:{content:[{type:'tool_result',tool_use_id:'tool-'+id,content:'Running in background'}]},tool_use_result:{backgroundTaskId:id}});
 }
 text('early','Deployment started');result('early-result','Deployment started');
});`, { mode: 0o700 });
  const session = SessionSchema.parse({ id: "chat", provider: "claude-code", title: "Deploy", appId: null, appName: null,
    cwd: directory, codexThreadId: null, createdAt: "2026-10-09T00:00:00Z", updatedAt: "2026-10-09T00:00:00Z", status: "idle", pinned: false, archived: false, order: 0 });
  const events: RuntimeEvent[] = [];
  const usage: number[] = [];
  let turnId = "deploy";
  let earlyReady!: () => void;
  let followupReady!: () => void;
  let finalReady!: () => void;
  let persistFinal!: () => void;
  const early = new Promise<void>(resolve => { earlyReady = resolve; });
  const followup = new Promise<void>(resolve => { followupReady = resolve; });
  const final = new Promise<void>(resolve => { finalReady = resolve; });
  const finalWrite = new Promise<void>(resolve => { persistFinal = resolve; });
  let approvals = 0;
  const client = new ClaudeCliClient({ command: executable, args: [], cwd: directory, requestTimeoutMs: 2_000,
    onUpdate: async (_id, update) => {
      if (update.sessionUpdate === "agent_message_final" && (update.content as { text: string }).text === "All background work finished") {
        finalReady(); await finalWrite;
      }
      if (update.sessionUpdate === "usage_update") usage.push(Number(update.replyOrdinal));
      const event = nativeAgentEvent(session, turnId, update);
      if (event) events.push(RuntimeEventSchema.parse(event));
      if (update.sessionUpdate === "agent_message_final") {
        if ((update.content as { text: string }).text === "Deployment started") earlyReady();
        if ((update.content as { text: string }).text.startsWith("Deploy checked")) followupReady();
      }
    },
    onPermission: async () => { approvals++; return { outcome: { outcome: "selected", optionId: "allow" } }; },
  });
  try {
    const native = await client.createSession(directory);
    const controller = new AbortController();
    let settled = false;
    const running = client.prompt(native.sessionId, [{ type: "text", text: mode }], controller.signal);
    // Attach both handlers before a forced process exit/cancellation.
    void running.then(() => { settled = true; }, () => { settled = true; });
    await early;
    const activities = () => buildChatMessages(events).flatMap(message => message.activities ?? []);
    expect(activities().filter(activity => activity.state === "running").map(activity => activity.callId).sort()).toEqual(["tool-check", "tool-deploy"]);
    expect(buildChatMessages(events).find(message => message.activities?.some(activity => activity.callId === "tool-deploy"))?.traceState).toBe("running");
    expect(settled).toBe(false);
    if (mode === "cancel") {
      controller.abort();
      expect(await running).toEqual({ stopReason: "cancelled" });
      expect(activities().filter(activity => activity.state === "running")).toHaveLength(0);
      expect(events.filter(event => event.name === "tool.completed").map(event => event.data)).toEqual(expect.arrayContaining([
        expect.objectContaining({ nativeTaskId: "deploy", status: "failed" }), expect.objectContaining({ nativeTaskId: "check", status: "failed" }),
      ]));
      return;
    }
    await client.setModel(native.sessionId, "finish-first");
    if (mode === "crash") {
      await expect(running).rejects.toThrow("exited (1)");
      expect(activities().filter(activity => activity.state === "running")).toHaveLength(0);
      return;
    }
    await followup;
    expect(settled).toBe(false);
    expect(approvals).toBe(1);
    expect(activities().filter(activity => activity.callId === "tool-deploy")).toHaveLength(1);
    expect(activities().find(activity => activity.callId === "tool-deploy")?.state).toBe(mode === "completed" ? "completed" : "failed");
    expect(activities().find(activity => activity.callId === "tool-check")?.state).toBe("running");
    expect(buildChatMessages(events).find(message => message.activities?.some(activity => activity.callId === "tool-check"))?.traceState).toBe("running");
    await client.setModel(native.sessionId, "finish-check");
    await final;
    expect(settled).toBe(false); // Persistence is part of completion.
    persistFinal();
    expect(await running).toEqual({ stopReason: "end_turn" });
    expect(usage).toEqual([0, 1, 2]);
    expect(activities().filter(activity => activity.callId === "tool-check")).toHaveLength(1);
    expect(activities().find(activity => activity.callId === "tool-check")?.state).toBe("completed");
    expect(buildChatMessages(events).filter(message => message.role === "activity_group" && message.traceState === "running")).toHaveLength(0);
    expect(buildChatMessages(events).filter(message => message.role === "assistant").map(message => message.content).filter(Boolean)).toEqual([
      "Deployment started", "Deploy checked; waiting for remaining work", "All background work finished",
    ]);
    const projector = new IncrementalChatProjector();
    for (let end = 1; end <= events.length; end++) {
      const prefix = events.slice(0, end);
      expect(projector.project(prefix)).toEqual(buildChatMessages(JSON.parse(JSON.stringify(prefix))));
    }
    turnId = "next";
    await client.prompt(native.sessionId, [{ type: "text", text: "next" }]);
    expect(buildChatMessages(events).filter(message => message.turnId === "next" && message.role === "assistant").map(message => message.content)).toEqual(["Next request"]);
  } finally { persistFinal(); await client.stop(); await rm(directory, { recursive: true, force: true }); }
});
