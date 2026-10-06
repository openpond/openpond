import { expect, it, vi } from "vitest";
import type { Approval, RuntimeEvent } from "@openpond/contracts";
import { createNativeAgentApprovals } from "../apps/server/src/runtime/native-agents/approvals.js";
import { buildChatMessages } from "../apps/web/src/lib/chat-messages.js";
import { createHash } from "node:crypto";
import { normalizeConnectedSession } from "../packages/evals/src/connected-evidence/normalize.js";
import { ownedNativeBoundaryIds } from "../apps/server/src/runtime/native-agents/history-ownership.js";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeNativeAgent } from "../apps/server/src/runtime/native-agents/setup.js";
import { nativeCapabilityProbeKey, nativeCapabilityProbeKeys } from "../apps/server/src/runtime/native-agents/capability-probes.js";

// Claude's supported auth status command exits 1 when signed out. Treating
// that as a broken installation hides the login action from ordinary users.
it.skipIf(process.platform === "win32")("distinguishes native signed-out JSON from a broken auth executable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-auth-status-"));
  const binaryPath = join(directory, "claude");
  try {
    await writeFile(binaryPath, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({loggedIn:false}));process.exit(1);\n`, { mode: 0o700 });
    const signedOut = await probeNativeAgent("claude-code", { binaryPath, sourceHome: directory }, { force: true });
    expect(signedOut.status).toBe("needs_login");
    expect(signedOut.session).toBeNull();
    await writeFile(binaryPath, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({loggedIn:true}));process.exit(2);\n`, { mode: 0o700 });
    const broken = await probeNativeAgent("claude-code", { binaryPath, sourceHome: directory }, { force: true });
    expect(broken.status).toBe("unavailable");
    expect(broken.session).toBeNull();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("persists cancelled native approval after an in-flight initial write and rejects its late reply", async () => {
  let release!: () => void;
  const write = new Promise<void>((resolve) => { release = resolve; });
  const states: Approval[] = [];
  const events: RuntimeEvent[] = [];
  const controller = new AbortController();
  const approvals = createNativeAgentApprovals({
    upsertApproval: async (value) => { if (value.status === "pending") await write; states.push(value); },
    appendRuntimeEvent: async (value) => { events.push(value); },
  });
  const pending = approvals.request("chat-one", "turn-one", { sessionId: "native-one", toolCall: { toolCallId: "same-vendor-tool-id" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] }, controller.signal);
  controller.abort(); release();
  expect(await pending).toEqual({ outcome: { outcome: "cancelled" } });
  expect(states.map((value) => value.status)).toEqual(["pending", "cancelled"]);
  expect(events.some((value) => value.name === "approval.requested")).toBe(false);
  expect(await approvals.resolve(states[0]!.id, { decision: "accept" })).toBeNull();
});

it("updates one retained assistant message when its native snapshot grows instead of duplicating text", () => {
  const event = (id: string, output: string): RuntimeEvent => ({ id, timestamp: "2026-10-02T00:00:00.000Z", sessionId: "retained", turnId: "turn", name: "assistant.delta", source: "provider", output, data: { retainedHistory: true, nativeMessageId: "stable-native-message" } });
  const messages = buildChatMessages([event("revision-one", "First"), event("revision-two", "First and second")]);
  expect(messages.filter((message) => message.role === "assistant").map((message) => message.content)).toEqual(["First and second"]);
});

// Question answers must resolve only the outstanding native request; arbitrary
// input patches and partial answers must never be forwarded to a running tool.
it("validates native question identity and rejects duplicate or late answers", async () => {
  let published!: (approval: Approval) => void;
  const ready = new Promise<Approval>((resolve) => { published = resolve; });
  const approvals = createNativeAgentApprovals({ upsertApproval: async (approval) => { if (approval.status === "pending") published(approval); }, appendRuntimeEvent: async () => undefined });
  const pending = approvals.request("chat", "turn", { sessionId: "native", toolCall: { toolCallId: "ask" }, questions: [{ question: "Which fixture?", options: [{ label: "Alpha" }, { label: "Beta" }] }], options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] }, new AbortController().signal);
  const approval = await ready;
  expect(approval.kind).toBe("user_input");
  await expect(approvals.resolve(approval.id, { decision: "accept", answers: { foreign: "Alpha" } })).rejects.toThrow("Answer each");
  await approvals.resolve(approval.id, { decision: "accept", answers: { "Which fixture?": "Alpha" } });
  expect(await pending).toEqual({ outcome: { outcome: "selected", optionId: "allow" }, answers: { "Which fixture?": "Alpha" } });
  expect(await approvals.resolve(approval.id, { decision: "accept", answers: { "Which fixture?": "Beta" } })).toBeNull();
});

it("does not hide a later external turn that repeats an OpenPond-owned prompt", () => {
  const prompt = "Identical text can belong to a different native turn.";
  const native = normalizeConnectedSession({ origin: "opencode", sessionId: "same-native-session", files: [], events: [1, 2].map((second) => ({ id: `request-${second}`, sequence: second, occurredAt: `2026-10-02T00:00:0${second}.000Z`, kind: "message", role: "user", content: prompt, callId: null, parentId: null, usage: null })) });
  const owned = ownedNativeBoundaryIds(native, [{ startedAt: "2026-10-02T00:00:00.500Z", completedAt: "2026-10-02T00:00:01.500Z", metadata: { nativePromptHash: createHash("sha256").update(prompt).digest("hex") } }]);
  expect([...owned]).toEqual([native.boundaries[0]!.id]);
  expect(owned.has(native.boundaries[1]!.id)).toBe(false);
});

// Automatic setup must never submit a paid prompt, and closing its UI must kill
// the owned pending probe rather than caching a late success for that account.
it.skipIf(process.platform === "win32")("checks native models without prompting and cancels the owned process without retaining its result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-setup-cancel-"));
  const binaryPath = join(directory, "agent");
  const trace = join(directory, "trace");
  const pidFile = join(directory, "pid");
  try {
    expect((await probeNativeAgent("opencode", { binaryPath, sourceHome: directory }, { force: true })).status).toBe("missing");
    await writeFile(binaryPath, `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const request = JSON.parse(line);
 fs.appendFileSync(${JSON.stringify(trace)}, request.method + '\\n');
 let result;
 if(request.method==='initialize') result={protocolVersion:1,agentCapabilities:{},authMethods:[]};
 else if(request.method==='session/new') {
  if(fs.existsSync(${JSON.stringify(join(directory, "hang"))})) return;
  result={sessionId:'setup-only',models:{currentModelId:'local-model',availableModels:[{modelId:'local-model',name:'Local model'}]}};
 } else process.exit(9);
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
});
`, { mode: 0o700 });
    const ready = await probeNativeAgent("opencode", { binaryPath, sourceHome: directory }, { force: true });
    expect(ready.status).toBe("ready");
    expect(ready.session?.models?.availableModels.map(model => model.modelId)).toEqual(["local-model"]);
    expect(await nativeCapabilityProbeKeys(directory)).toContain(nativeCapabilityProbeKey("opencode", "setup-only"));
    expect((await readFile(trace, "utf8")).trim().split("\n")).toEqual(["initialize", "session/new"]);
    await writeFile(join(directory, "hang"), "1");
    await writeFile(trace, "");
    const controller = new AbortController();
    const pending = probeNativeAgent("opencode", { binaryPath, sourceHome: directory }, { force: true, signal: controller.signal });
    const cancelled = expect(pending).rejects.toThrow("cancelled setup");
    await vi.waitFor(async () => expect(await readFile(trace, "utf8")).toContain("session/new"));
    const pid = Number(await readFile(pidFile, "utf8"));
    controller.abort(new Error("cancelled setup"));
    await cancelled;
    expect(() => process.kill(pid, 0)).toThrow();
    // The preceding ready result remains intact; cancellation is not an auth failure.
    expect((await probeNativeAgent("opencode", { binaryPath, sourceHome: directory })).status).toBe("ready");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
