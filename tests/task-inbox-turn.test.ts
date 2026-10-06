import { expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProvidersFile, normalizeProvidersFile } from "../apps/server/src/openpond/provider-settings.js";
import { hostedCompactionPriorEvents, openRouterProviderSettingsWithContextWindow } from "./helpers/byok-turn-runner-harness";
import { createTurnRunnerTestHarness, turnRunnerTestSession } from "./helpers/turn-runner-test-harness";
import { qualifyLocalManagedMessaging } from "./helpers/local-managed-live-qualification";

// Failure story: an installed adapter acknowledges transport but never consumes
// a queued follow-up, loses original-session context, or duplicates it on restart.
// Real models run only with explicit qualification authorization/environment.
test.runIf(process.env.OPENPOND_QUALIFY_LOCAL_MESSAGING === "1").each(["claude-code", "opencode", "codex"] as const)(
  "installed %s consumes local follow-ups in the original session", qualifyLocalManagedMessaging, 240_000,
);

function gate() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }

// Failure story: steering cancels completed/running work, executes stale proposed actions, or loses the original assignment.
test("steering preserves an admitted tool and the assignment across request replacement and compaction", async () => {
  const generating = gate(), toolStarted = gate(), releaseTool = gate();
  const executed: string[] = [];
  const requests: string[] = [];
  let pass = 0;
  let toolSignal: AbortSignal | undefined;
  const harness = createTurnRunnerTestHarness({
    sessions: [turnRunnerTestSession({ experience: "development" })],
    events: hostedCompactionPriorEvents(1_000).map((event) => ({ ...event, sessionId: "session_test" })),
    dependencies: {
      maxHostedWorkspaceToolRounds: 6,
      loadProviderSettings: async () => openRouterProviderSettingsWithContextWindow(32_000),
      harnessModelTools: [{ name: "boundary_tool", description: "Boundary tool", parameters: { type: "object", properties: {}, additionalProperties: false },
        execute: async (context) => {
          executed.push(context.callId); toolSignal = context.signal; toolStarted.resolve(); await releaseTool.promise;
          return { toolCallId: context.callId, name: "boundary_tool", ok: true, contentText: "durable tool result", data: {} };
        },
      }],
      streamLocalByokChatTurn: async function* (input) {
        if (input.requestId?.startsWith("compact-") || input.requestId?.includes(":context-compaction:")) {
          yield { text: "Earlier history was summarized. Continue the current implementation." };
          return;
        }
        pass++;
        requests.push(JSON.stringify(input.messages));
        if (pass === 1) {
          yield { text: "Partial plan", toolCalls: [{ id: "incomplete", type: "function", function: { name: "boundary_tool", arguments: '{"unfinished":' } }] };
          generating.resolve();
          await new Promise<void>((_, reject) => {
            if (input.signal.aborted) reject(input.signal.reason);
            else input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true });
          });
        } else if (pass === 2) {
          yield { toolCalls: ["admitted", "stale-proposal"].map((id) => ({ id, type: "function", function: { name: "boundary_tool", arguments: "{}" } })) };
        } else if (pass === 3) throw new Error("maximum context length exceeded");
        else yield { text: "Finished the original assignment with both corrections." };
      },
    },
  });
  const turnPromise = harness.runner.sendTurn("session_test", { prompt: "Compare the approaches and deliver the chosen implementation.", modelRef: { providerId: "openrouter", modelId: "test/model" } });
  await generating.promise;
  const turnId = harness.state.turns[0]!.id;
  await harness.runner.steerSessionTurn("session_test", { prompt: "Preserve the public API.", expectedTurnId: turnId, idempotencyKey: "first" });
  await toolStarted.promise;
  await harness.runner.steerSessionTurn("session_test", { prompt: "Use the existing data format.", expectedTurnId: turnId, idempotencyKey: "second" });
  expect(toolSignal?.aborted).toBe(false);
  releaseTool.resolve();
  expect(await turnPromise).toMatchObject({ id: turnId, status: "completed" });
  expect(harness.state.turns).toHaveLength(1);
  expect(executed).toEqual(["admitted"]);
  expect(harness.state.events.filter((event) => event.name === "session.compaction.completed")).toHaveLength(1);
  expect(requests[3]).toContain("Compare the approaches and deliver the chosen implementation.");
  expect(requests[3]).toContain("Preserve the public API.");
  expect(requests[3]).toContain("Use the existing data format.");
  expect(requests[2]).toContain("durable tool result");
  expect(requests[2]).toContain("pending_user_steer");
  expect((await harness.runner.readTaskInbox("session_test")).inputs.map((input) => input.state)).toEqual(["resolved", "resolved"]);
  await harness.runner.close();
});

// Failure story: a peer can broaden a recipient's read-only execution policy by requesting another assignment.
test("peer follow-up uses the recipient's persisted execution permissions", async () => {
  const observed: string[] = [];
  let sent = false, probed = false;
  const harness = createTurnRunnerTestHarness({ sessions: ["sender", "recipient"].map((id) =>
    turnRunnerTestSession({ id, experience: "development", localProjectId: "shared-project" })),
    dependencies: {
      harnessModelTools: [{ name: "permission_probe", description: "Inspect execution permissions", parameters: { type: "object", properties: {}, additionalProperties: false },
        execute: async (context) => {
          observed.push(context.turnPermissions.sandbox);
          return { toolCallId: context.callId, name: "permission_probe", ok: true, contentText: "inspected", data: {} };
        } }],
      streamLocalByokChatTurn: async function* (input) {
        const messages = JSON.stringify(input.messages);
        if (messages.includes("Dispatch restricted followup") && !sent) {
          sent = true;
          yield { toolCalls: [{ id: "assign", type: "function", function: { name: "openpond_followup_task", arguments: JSON.stringify({ taskId: "recipient", message: "Probe execution permissions" }) } }] };
        } else if (messages.includes("Probe execution permissions") && !messages.includes("Dispatch restricted followup") && !probed) {
          probed = true;
          yield { toolCalls: [{ id: "probe", type: "function", function: { name: "permission_probe", arguments: "{}" } }] };
        } else yield { text: "Done" };
      },
    },
  });
  await harness.runner.sendTurn("recipient", { prompt: "Establish read only", sandbox: "read-only", modelRef: { providerId: "openrouter", modelId: "test/model" } });
  await harness.runner.sendTurn("sender", { prompt: "Dispatch restricted followup", sandbox: "danger-full-access", modelRef: { providerId: "openrouter", modelId: "test/model" } });
  await harness.dependencies.turnFollowUpQueue.drain();
  expect(observed).toEqual(["read-only"]);
  expect(harness.state.turns.filter((turn) => turn.sessionId === "recipient")).toHaveLength(2);
  await harness.runner.close();
});

// Failure story: a native turn starts from a queued instruction but never dispatches
// its receipt or a pending peer message; it is falsely completed merely at enqueue.
// This runs the real native ACP transport against an isolated fixture executable.
test.skipIf(process.platform === "win32").each(["resolved", "failed"] as const)("native dispatch includes pending inputs once and records a %s provider request", async (outcome) => {
  const directory = await mkdtemp(join(tmpdir(), "native-inbox-dispatch-"));
  const binaryPath = join(directory, "fixture-acp");
  const trace = join(directory, "prompt.json"), ready = join(directory, "ready"), release = join(directory, "release");
  const sessionId = "native-recipient";
  const harness = createTurnRunnerTestHarness({ sessions: [
    turnRunnerTestSession({ id: sessionId, experience: "chat", provider: "opencode", modelRef: null, cwd: directory, localProjectId: "shared" }),
    turnRunnerTestSession({ id: "peer", experience: "chat", localProjectId: "shared" }),
  ], dependencies: { storageHome: directory, defaultSessionCwd: () => directory } });
  try {
    await writeProvidersFile(join(directory, "providers.json"), normalizeProvidersFile({ providers: { opencode: { enabled: true, binaryPath, sourceHome: directory } } }));
    await writeFile(binaryPath, `#!${process.execPath}\n` + `
const fs = require('node:fs');
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const request = JSON.parse(line);
 const reply = result => send({jsonrpc:'2.0', id:request.id, result});
 if(request.method==='initialize') reply({protocolVersion:1,agentCapabilities:{},authMethods:[]});
 else if(request.method==='session/new') {
  fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
  const timer = setInterval(() => { if(fs.existsSync(${JSON.stringify(release)})) { clearInterval(timer); reply({sessionId:'exact-vendor-session'}); } }, 10);
  } else if(request.method==='session/prompt') {
  fs.writeFileSync(${JSON.stringify(trace)}, JSON.stringify(request.params));
  if(${JSON.stringify(outcome)}==='failed') { send({jsonrpc:'2.0',id:request.id,error:{code:-32000,message:'Fixture provider failed after inclusion'}}); return; }
  send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'exact-vendor-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Fixture response'}}}});
  reply({stopReason:'end_turn'});
 } else reply({});
});
`, { mode: 0o700 });
    const queued = await harness.runner.queueTaskInput(sessionId, { prompt: "Original queued assignment" }, "queued-native-assignment");
    await vi.waitFor(async () => expect(await readFile(ready, "utf8")).toBe("ready"));
    const pending = await harness.dependencies.store.admitTaskInput({ id: "peer-before-dispatch", sessionId, senderSessionId: "peer", senderKind: "task", kind: "message",
      body: "Preserve this pending peer instruction", payload: {}, idempotencyKey: "peer-before", replyTo: null, expectedTurnId: null });
    expect(await harness.dependencies.store.getTaskInput(queued.id)).toMatchObject({ state: "pending" });
    expect(await harness.dependencies.store.getTaskInput(pending.id)).toMatchObject({ state: "pending" });
    await writeFile(release, "release");
    await harness.dependencies.turnFollowUpQueue.drain();
    const params = JSON.parse(await readFile(trace, "utf8")) as { sessionId: string; prompt: Array<{ text: string }> };
    expect(params.sessionId).toBe("exact-vendor-session");
    const prompt = params.prompt[0]!.text;
    expect(prompt.split("Original queued assignment")).toHaveLength(2);
    expect(prompt).toContain(pending.body);
    expect(harness.state.turns).toHaveLength(1);
    const turn = harness.state.turns[0]!;
    expect(turn).toMatchObject({ status: outcome === "resolved" ? "completed" : "failed", metadata: { nativePromptHash: createHash("sha256").update(prompt).digest("hex") } });
    const inputs = (await harness.runner.readTaskInbox(sessionId)).inputs;
    expect(inputs.map((input) => ({ id: input.id, state: input.state, turnId: input.turnId }))).toEqual([
      { id: queued.id, state: outcome === "resolved" ? "resolved" : "included", turnId: turn.id }, { id: pending.id, state: outcome === "resolved" ? "resolved" : "included", turnId: turn.id },
    ]);
    expect(inputs.every((input) => input.requestIds.length === 1)).toBe(true);
    expect(harness.state.events.some((event) => event.name === "assistant.delta" && event.output === "Fixture response")).toBe(outcome === "resolved");
    if (outcome === "failed") {
      expect(inputs.every((input) => input.error?.includes("failed"))).toBe(true);
      expect(await harness.dependencies.store.taskInboxPaused(sessionId)).toBe(true);
    }
  } finally { await harness.runner.close(); await rm(directory, { recursive: true, force: true }); }
});
