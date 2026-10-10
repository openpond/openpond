// @test-tier unit — child processes are EventEmitter doubles; none are spawned.
import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { expect, test } from "vitest";
import { waitForExitOrSignal } from "../scripts/dev-runner.js";

function child() {
  return Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null }) as unknown as ChildProcessWithoutNullStreams;
}

// Restarting Electron must leave monitoring intact without accumulating exit listeners.
test("desktop restart detaches old listeners and continues monitoring the existing backend", async () => {
  const server = child();
  const desktop = child();
  const running = [{ id: "server", child: server }, { id: "desktop", child: desktop }];
  const first = waitForExitOrSignal(running);
  desktop.emit("exit", 75, null);
  expect(await first).toEqual({ id: "desktop", code: 75, signal: null });
  expect(server.listenerCount("exit")).toBe(0);
  running[1] = { id: "desktop", child: child() };
  const second = waitForExitOrSignal(running);
  server.emit("exit", 1, null);
  expect(await second).toEqual({ id: "server", code: 1, signal: null });
  expect(running[1].child.listenerCount("exit")).toBe(0);
});

test("notices a backend that exited during the desktop restart gap", async () => {
  const server = child();
  server.exitCode = 1;
  const desktop = child();
  expect(await waitForExitOrSignal([{ id: "server", child: server }, { id: "desktop", child: desktop }])).toEqual({ id: "server", code: 1, signal: null });
  expect(desktop.listenerCount("exit")).toBe(0);
});
