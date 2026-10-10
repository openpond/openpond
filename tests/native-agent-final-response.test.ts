import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { RuntimeEventSchema, SessionSchema, type RuntimeEvent } from "@openpond/contracts";
import { ClaudeCliClient } from "../packages/agent-runtime/src/acp/claude-cli-client.js";
import { nativeAgentEvent } from "../apps/server/src/runtime/native-agents/events.js";
import { buildChatMessages } from "../apps/web/src/lib/chat-messages.js";
import { IncrementalChatProjector } from "../apps/web/src/lib/incremental-chat-projector.js";

// The result repeats (or revises) streamed text. Cover the complete CLI-to-chat
// boundary so it cannot duplicate the answer, erase progress, or publish a
// successful summary for an interrupted/failed turn, including after replay.
// Progress must stay visible as text, while actual thinking remains separate.
it.skipIf(process.platform === "win32")("promotes Claude's authoritative result once and persists it before settling the turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openpond-claude-final-"));
  const executable = join(directory, "claude");
  await writeFile(executable, `#!${process.execPath}\n` + String.raw`
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const stream = event => send({type:'stream_event',event});
let session, previousResult;
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const input = JSON.parse(line);
 if(input.type === 'control_request') {
  send({type:'control_response',response:{subtype:'success',request_id:input.request_id,response:{}}});
  if(input.request.subtype === 'interrupt') { send({type:'result',session_id:session,is_error:false,result:'Cancelled result must not appear'}); send({type:'system',subtype:'session_state_changed',state:'idle'}); }
  return;
 }
 if(input.type !== 'user') return;
 session = input.session_id;
 // Replay the prior completion only after the next prompt has been admitted.
 // This makes the cross-turn stdout race deterministic instead of chunk-dependent.
 if(previousResult) send(previousResult);
 const mode = input.message.content[0].text;
 send({type:'system',subtype:'status',status:'compacting'});
 if(mode !== 'cancel' && mode !== 'error') send({type:'system',subtype:'compact_boundary',compact_metadata:{trigger:'auto',pre_tokens:180000}});
 stream({type:'message_start',message:{id:'progress',model:'claude-fixture',usage:{input_tokens:100,cache_read_input_tokens:900,cache_creation_input_tokens:50}}});
 stream({type:'content_block_delta',delta:{type:'text_delta',text:'Progress for ' + mode}});
 send({type:'assistant',message:{id:'progress',content:[{type:'text',text:'Progress for ' + mode}]}});
 if(mode === 'cancel') return;
 stream({type:'content_block_start',content_block:{type:'tool_use',id:'read',name:'Read',input:{}}});
 send({type:'assistant',message:{id:'progress',content:[{type:'tool_use',id:'read',name:'Read',input:{path:'input.txt'}}]}});
 send({type:'user',message:{content:[{type:'tool_result',tool_use_id:'read',content:[{type:'text',text:'Read input'}]}]}});
 stream({type:'content_block_start',content_block:{type:'tool_use',id:'shell',name:'Bash',input:{}}});
 send({type:'assistant',message:{id:'progress',content:[{type:'tool_use',id:'shell',name:'Bash',input:{command:'ls -la'}}]}});
 send({type:'user',message:{content:[{type:'tool_result',tool_use_id:'shell',is_error:true,content:'command failed'}]}});
 if(mode === 'error') {
  send({type:'result',session_id:session,is_error:true,result:'Failed result must not appear',errors:['Fixture failure']});
  return;
 }
 if(mode === 'stream') {
  stream({type:'message_start',message:{id:'answer',model:'claude-fixture',usage:{input_tokens:200,cache_read_input_tokens:1500,cache_creation_input_tokens:0}}});
 stream({type:'message_delta',usage:{output_tokens:75}});
  stream({type:'content_block_delta',delta:{type:'thinking_delta',thinking:'Checked the result'}});
  stream({type:'content_block_delta',delta:{type:'text_delta',text:'Provisional '}});
  stream({type:'content_block_delta',delta:{type:'text_delta',text:'answer'}});
  send({type:'assistant',message:{id:'answer',content:[{type:'text',text:'Provisional answer'}]}});
 }
 previousResult = {type:'result',uuid:require('node:crypto').randomUUID(),session_id:session,is_error:false,result:'Final for ' + mode,usage:{input_tokens:300,cache_read_input_tokens:2400,cache_creation_input_tokens:50,output_tokens:100},modelUsage:{'claude-fixture':{inputTokens:9999999,contextWindow:200000}},total_cost_usd:999};
 send(previousResult);
 send(previousResult);
 send({type:'system',subtype:'session_state_changed',state:'idle'});
});`, { mode: 0o700 });

  const session = SessionSchema.parse({
    id: "chat", provider: "claude-code", title: "Fixture", appId: null, appName: null,
    cwd: directory, codexThreadId: null, createdAt: "2026-10-06T00:00:00Z", updatedAt: "2026-10-06T00:00:00Z",
    status: "idle", pinned: false, archived: false, order: 0,
  });
  const events: RuntimeEvent[] = [];
  let turnId = "stream";
  let finalPending!: () => void;
  let persistFinal!: () => void;
  let cancellationReady!: () => void;
  const finalReady = new Promise<void>((resolve) => { finalPending = resolve; });
  const finalWrite = new Promise<void>((resolve) => { persistFinal = resolve; });
  const cancelReady = new Promise<void>((resolve) => { cancellationReady = resolve; });
  const client = new ClaudeCliClient({
    command: executable, args: [], cwd: directory, requestTimeoutMs: 2_000,
    onUpdate: async (_id, update) => {
      if (turnId === "stream" && update.sessionUpdate === "agent_message_final") {
        finalPending();
        await finalWrite;
      }
      const event = nativeAgentEvent(session, turnId, update);
      if (event) events.push(RuntimeEventSchema.parse(event));
      if (turnId === "cancel" && update.sessionUpdate === "agent_message_chunk") cancellationReady();
    },
  });
  try {
    const native = await client.createSession(directory);
    const prompt = (signal?: AbortSignal) => client.prompt(native.sessionId, [{ type: "text", text: turnId }], signal);
    let settled = false;
    const first = prompt().then((result) => { settled = true; return result; });
    await finalReady;
    expect(settled).toBe(false);
    const live = buildChatMessages(events);
    expect(live.filter((message) => message.role === "assistant" && message.content).map((message) => message.content)).toEqual([
      "Progress for stream", "Provisional answer",
    ]);
    expect(live.map((message) => message.reasoningContent).filter(Boolean)).toEqual([
      "Checked the result",
    ]);
    persistFinal();
    expect(await first).toEqual({ stopReason: "end_turn" });
    const finished = buildChatMessages(events);
    const activities = finished.flatMap((message) => message.activities ?? []);
    expect(activities.filter((activity) => activity.callId === "read")).toHaveLength(1);
    expect(activities.find((activity) => activity.callId === "read")).toMatchObject({ content: "input.txt", detail: expect.stringContaining("Read input"), state: "completed" });
    expect(activities.filter((activity) => activity.callId === "shell")).toHaveLength(1);
    expect(activities.find((activity) => activity.callId === "shell")).toMatchObject({ content: "ls -la", detail: "command failed", state: "failed", kind: "command" });
    expect(events.find((event) => event.name === "session.context.updated")?.data).toMatchObject({ usedTokens: 1775, maxContextTokens: 200000 });
    expect(events.filter((event) => event.action === "native_usage")).toHaveLength(1);
    expect(events.find((event) => event.action === "native_usage")?.data).toMatchObject({ model: "claude-fixture", usage: { input_tokens: 300, cache_read_input_tokens: 2400 }, scope: "main_loop_turn" });
    expect(finished.filter((message) => message.statusKind === "compaction").map((message) => message.statusState)).toEqual(["completed"]);
    expect(finished.at(-1)?.content).toBe("Final for stream");
    expect(finished.map((message) => message.role === "assistant" ? message.content : "").filter(Boolean)).toEqual(["Progress for stream", "Final for stream"]);
    expect(finished.map((message) => message.reasoningContent).filter(Boolean)).toEqual(["Checked the result"]);

    turnId = "result-only";
    await prompt();
    const second = buildChatMessages(events).filter((message) => message.turnId === turnId);
    expect(second.at(-1)?.content).toBe("Final for result-only");
    expect(second.some((message) => message.content === "Progress for result-only")).toBe(true);

    turnId = "error";
    await expect(prompt()).rejects.toThrow("Fixture failure");
    turnId = "cancel";
    const controller = new AbortController();
    const cancelled = prompt(controller.signal);
    await cancelReady;
    controller.abort();
    expect(await cancelled).toEqual({ stopReason: "cancelled" });

    expect(buildChatMessages(events).filter((message) => ["error", "cancel"].includes(message.turnId ?? "") && message.statusKind === "compaction").map((message) => message.statusState)).toEqual(["failed", "failed"]);
    // A fresh projection of the persisted event payloads is the reload path.
    const replayed = buildChatMessages(JSON.parse(JSON.stringify(events)));
    expect(replayed.filter((message) => message.role === "assistant" && message.content).map((message) => [message.turnId, message.content])).toEqual([
      ["stream", "Progress for stream"], ["stream", "Final for stream"],
      ["result-only", "Progress for result-only"], ["result-only", "Final for result-only"],
      ["error", "Progress for error"], ["cancel", "Progress for cancel"],
    ]);
    // This fixture captures provider events, without the turn runner's lifecycle
    // events. Check streaming/replay parity within each provider turn.
    for (const id of ["stream", "result-only", "error", "cancel"]) {
      const projector = new IncrementalChatProjector();
      const turnEvents = events.filter((event) => event.turnId === id);
      for (let end = 1; end <= turnEvents.length; end++) {
        const prefix = turnEvents.slice(0, end);
        expect(projector.project(prefix)).toEqual(buildChatMessages(prefix));
      }
    }
    // Already-saved commentary used the reasoning event name. Its explicit
    // phase still identifies visible progress when the user reopens the chat.
    expect(buildChatMessages(events.map((event) =>
      (event.data as { phase?: string } | null)?.phase === "commentary"
        ? { ...event, name: "assistant.reasoning.delta" as const }
        : event,
    ))).toEqual(replayed);
  } finally {
    persistFinal();
    await client.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
