import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, test, vi } from "vitest";

const native = vi.hoisted(() => ({ child: null as unknown }));
vi.mock("node:child_process", () => ({ spawn: () => native.child }));
vi.mock("../packages/codex-provider/src/binary.js", () => ({ resolveCodexBinary: async () => ({ command: "test-codex", supportsListen: true }) }));

import { awaitCodexTurn } from "../apps/server/src/runtime/await-codex-turn.js";

import { CodexAppServerClient } from "../packages/codex-provider/src/client.js";

// Failure story: native steering keeps the text but drops image input when
// serializing the already accepted correction into the Codex protocol.
test("steering delivers image input with the expected active turn", async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn() });
  native.child = child;
  const requests: Array<{ method: string; params: unknown }> = [];
  child.stdin.on("data", chunk => {
    const request = JSON.parse(String(chunk)); requests.push(request);
    queueMicrotask(() => child.stdout.write(JSON.stringify({ id: request.id, result: { turnId: "active-turn" } }) + "\n"));
  });
  const client = new CodexAppServerClient({ binaryPath: "test-codex" });
  await client.start();
  try {
    await client.steerTurn({ threadId: "thread", expectedTurnId: "active-turn", prompt: "Use this screenshot", images: ["data:image/png;base64,ZmFrZQ=="] });
    expect(requests).toContainEqual(expect.objectContaining({ method: "turn/steer", params: {
      threadId: "thread", expectedTurnId: "active-turn", input: [{ type: "text", text: "Use this screenshot", text_elements: [] }, { type: "image", url: "data:image/png;base64,ZmFrZQ==" }],
    } }));
  } finally { const stopping = client.stop(); child.emit("close", 0, null); await stopping; }
});

// Failure story: exit can occur before stdout closes; acknowledging only exit
// allows a late terminal notification to alter already-sealed case evidence.
test("native shutdown acknowledges closed stdio and is shared by concurrent callers", async () => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn(),
  });
  native.child = child;
  const notify = vi.fn();
  const client = new CodexAppServerClient({ binaryPath: "test-codex", clientName: "test", clientTitle: "test",
    clientVersion: "test", onNotification: notify });
  await client.start();
  let settled = false;
  const stopping = client.stopAndWait().then(() => { settled = true; });
  const concurrent = client.stop();
  child.emit("exit", 0, null);
  await Promise.resolve();
  expect(settled).toBe(false);
  child.stdout.write(JSON.stringify({ method: "turn/completed", params: { turn: { id: "owned", status: "completed" } } }) + "\n");
  expect(notify).toHaveBeenCalledTimes(1);
  child.emit("close", 0, null);
  await Promise.all([stopping, concurrent]);
  expect(settled).toBe(true);
  expect(child.kill).toHaveBeenCalledTimes(1);
});

// Codex sends structured turn failures; string coercion loses the reason and
// leaves users with [object Object] across both the CLI and desktop.
test("preserves the provider's structured turn failure message", async () => {
  const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),stdin:new PassThrough(),kill:vi.fn()});
  native.child=child;
  const client=new CodexAppServerClient({binaryPath:"test-codex"});
  await client.start();
  const failed=client.waitForTurn("failed-turn");
  const check=expect(failed).rejects.toThrow("The model is temporarily unavailable. Try again later.");
  child.stdout.write(JSON.stringify({method:"turn/completed",params:{turn:{id:"failed-turn",status:"failed",error:{message:"The model is temporarily unavailable. Try again later.",codexErrorInfo:"other"}}}})+"\n");
  await check;
  const stopping=client.stop();child.emit("close",0,null);await stopping;
});

// Failure story: a healthy interactive run used to be killed at ten minutes,
// while evaluation owners must still enforce the deadline they explicitly set.
test("interactive turns stay live past ten minutes and explicit execution deadlines still settle", async () => {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn(),
  });
  native.child = child;
  const client = new CodexAppServerClient({ binaryPath: "test-codex" });
  try {
    await client.start();
    let completed = false;
    const interactive = awaitCodexTurn({ client, turnId: "interactive", signal: new AbortController().signal }).then(() => { completed = true; });
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(completed).toBe(false);
    expect(child.kill).not.toHaveBeenCalled();
    child.stdout.write(JSON.stringify({ method: "turn/completed", params: { turn: { id: "interactive", status: "completed" } } }) + "\n");
    await interactive;
    const bounded = expect(client.waitForTurn("evaluation", 5_000)).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(5_000);
    await bounded;
  } finally {
    const stopping = client.stop(); child.emit("close", 0, null); await stopping;
    vi.useRealTimers();
  }
});
