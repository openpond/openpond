import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, test, vi } from "vitest";

const native = vi.hoisted(() => ({ child: null as unknown }));
vi.mock("node:child_process", () => ({ spawn: () => native.child }));
vi.mock("../packages/codex-provider/src/binary.js", () => ({ resolveCodexBinary: async () => ({ command: "test-codex", supportsListen: true }) }));

import { CodexAppServerClient } from "../packages/codex-provider/src/client.js";

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
