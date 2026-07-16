import { describe, expect, test } from "vitest";
import { openTerminalEvents } from "../apps/terminal/src/events";
import { createTerminalInteractiveState } from "../apps/terminal/src/interactive-state";

function event(overrides: Record<string, unknown>) {
  return {
    id: "event-1",
    name: "diagnostic",
    timestamp: "2026-07-10T00:00:00.000Z",
    source: "server",
    ...overrides,
  } as Parameters<ReturnType<typeof createTerminalInteractiveState>["applyRuntimeEvent"]>[0];
}

describe("terminal interactive state", () => {
  test("gates startup and switching while tracking the active turn by session and turn id", () => {
    const state = createTerminalInteractiveState("session-a");

    expect(state.snapshot()).toEqual({ phase: "starting", activeSessionId: "session-a", activeTurnId: null });
    expect(state.beginTurn("session-a")).toMatchObject({ ok: false });

    state.completeStartup("session-a");
    expect(state.beginTurn("session-a")).toEqual({ ok: true });
    state.applyRuntimeEvent(event({ name: "turn.started", sessionId: "session-a", turnId: "turn-a" }));
    expect(state.snapshot()).toEqual({ phase: "running", activeSessionId: "session-a", activeTurnId: "turn-a" });
    expect(state.beginSessionSwitch()).toMatchObject({ ok: false });

    state.applyRuntimeEvent(event({ name: "turn.completed", sessionId: "session-a", turnId: "older-turn" }));
    expect(state.snapshot().phase).toBe("running");
    state.applyRuntimeEvent(event({ name: "turn.completed", sessionId: "session-a", turnId: "turn-a" }));
    expect(state.snapshot().phase).toBe("ready");

    expect(state.beginSessionSwitch()).toEqual({ ok: true });
    expect(state.snapshot().phase).toBe("switching");
    state.completeSessionSwitch("session-b");
    expect(state.snapshot()).toEqual({ phase: "ready", activeSessionId: "session-b", activeTurnId: null });
    state.beginStopping();
    expect(state.snapshot().phase).toBe("stopping");
    expect(state.beginTurn("session-b")).toMatchObject({ ok: false });
  });

  test("reconnects the server-side event filter and waits for the new session ready frame", async () => {
    const requests: string[] = [];
    let activeSessionId = "session-a";
    let resolveSecondEvent!: () => void;
    const secondEvent = new Promise<void>((resolve) => {
      resolveSecondEvent = resolve;
    });
    const encoder = new TextEncoder();
    const handle = await openTerminalEvents({
      server: "http://127.0.0.1:17874",
      token: "token",
      activeSessionId: () => activeSessionId,
      reconnectDelayMs: () => 1,
      onEvent: (runtimeEvent) => {
        if (runtimeEvent.sessionId === "session-b") resolveSecondEvent();
      },
      fetchImpl: async (url, init) => {
        requests.push(String(url));
        const requestNumber = requests.length;
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode("event: ready\ndata: {}\n\n"));
            if (requestNumber === 2) {
              controller.enqueue(encoder.encode(
                'data: {"id":"event-b","name":"turn.started","sessionId":"session-b","turnId":"turn-b","timestamp":"2026-07-10T00:00:00.000Z"}\n\n',
              ));
            }
            init?.signal?.addEventListener("abort", () => controller.close(), { once: true });
          },
        }));
      },
    });

    await handle.ready;
    activeSessionId = "session-b";
    await handle.switchSession("session-b");
    await secondEvent;
    handle.abort();

    expect(new URL(requests[0]!).searchParams.get("sessionId")).toBe("session-a");
    expect(new URL(requests[1]!).searchParams.get("sessionId")).toBe("session-b");
  });
});
