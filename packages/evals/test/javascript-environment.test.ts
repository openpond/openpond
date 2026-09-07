import { expect, test, vi } from "vitest";
import { contentHash } from "@openpond/harness";
import { createLearningTextAsset } from "../src/learning/assets.js";
import { sealLearningContent } from "../src/learning/contracts.js";
import { createJavaScriptEnvironmentSession, executeJavaScriptEnvironment, JavaScriptEnvironmentDefinitionSchema } from "../src/javascript-environment.js";
import { runJavaScriptEnvironmentAttempt } from "../src/javascript-environment-attempt.js";

const source = `
export function create({ initialState }) { return { state: initialState, observation: {} }; }
export function reset({ initialState }) { return { state: initialState, observation: { ready: true } }; }
export function step({ state, input, action }) {
  if (action.name === 'read') return { state, observation: { value: state[action.arguments.id] } };
  if (action.arguments.id !== input.allowedId) return { state, observation: { error: 'outside_scope' } };
  return { state: { ...state, [action.arguments.id]: action.arguments.value }, observation: { updated: true } };
}
export function collect({ state }) { return { state, observation: { complete: true } }; }
export function destroy() { return { state: {}, observation: {} }; }
`;

function fixture(module = source) {
  const asset = createLearningTextAsset({ text: module, path: "environment.mjs", mediaType: "application/javascript", visibility: "host_private" });
  const readSchema = { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false };
  const writeSchema = { type: "object", properties: { id: { type: "string" }, value: { type: "integer" } }, required: ["id", "value"], additionalProperties: false };
  const definition = JavaScriptEnvironmentDefinitionSchema.parse(sealLearningContent({ schemaVersion: "openpond.javascriptEnvironment.v1", id: "scoped-records", revision: 1, module: asset.asset,
    tools: [{ name: "read", description: "Read one record", inputSchema: readSchema, inputSchemaHash: contentHash(readSchema), sideEffect: "read", timeoutMs: 1_000 }, { name: "update", description: "Update an allowed record", inputSchema: writeSchema, inputSchemaHash: contentHash(writeSchema), sideEffect: "write", timeoutMs: 1_000 }], maxSteps: 4, maxStateBytes: 4_096, maxObservationBytes: 1_024, operationTimeoutMs: 1_000 }));
  return { definition, asset, input: { allowedId: "a" }, initialState: { a: 1, b: 2 }, seed: 7 };
}

// Worker startup/cleanup can take longer than one second while remaining inside
// the package's declared operation budget. An implicit shorter cap previously
// turned collected hosted attempts into cleanup failures.
test("cleanup honors the declared operation budget and still expires at its limit", async () => {
  for (const budget of [2_000, 1_000]) {
    const input = fixture();
    const { contentHash: _hash, ...content } = input.definition;
    const definition = JavaScriptEnvironmentDefinitionSchema.parse(sealLearningContent({ ...content, operationTimeoutMs: budget }));
    const session = await createJavaScriptEnvironmentSession({ ...input, definition, execute: async operation => {
      if (operation.operation === "destroy") {
        await new Promise<void>((resolve, reject) => {
          const complete = setTimeout(() => { clearTimeout(deadline); resolve(); }, 1_500);
          const deadline = setTimeout(() => { clearTimeout(complete); reject(new Error("environment_timeout")); }, operation.timeoutMs);
        });
      }
      return executeJavaScriptEnvironment(operation);
    } });
    await session.collect();
    vi.useFakeTimers();
    try {
      const outcome = session.destroy().then(() => "cleaned", error => error.message);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(await outcome).toBe(budget === 2_000 ? "cleaned" : "environment_timeout");
      await expect(session.collect()).rejects.toThrow("environment_closed");
    } finally { vi.useRealTimers(); }
  }
});

// Model arguments must drive actual isolated transitions. Caller mutation,
// invalid arguments, scope errors and step exhaustion must not forge final state.
test("owns tool state and records real scoped transitions with private source identity", async () => {
  const input = fixture();
  const session = await createJavaScriptEnvironmentSession(input);
  try {
    input.initialState.a = 99;
    session.definition.tools[0]!.inputSchema.additionalProperties = true;
    const observed = await session.step({ name: "read", arguments: { id: "a" } });
    expect(observed).toEqual({ value: 1 });
    observed.value = 500;
    const action = { name: "update", arguments: { id: "a", value: 40 } };
    const updating = session.step(action);
    action.arguments.value = 500;
    await expect(session.collect()).rejects.toThrow("operation_in_progress");
    expect(await updating).toEqual({ updated: true });
    await expect(session.step({ name: "read", arguments: { id: "a", forged: true } })).rejects.toThrow("invalid_arguments");
    expect(await session.step({ name: "update", arguments: { id: "b", value: 90 } })).toEqual({ error: "outside_scope" });
    await expect(session.step({ name: "read", arguments: { id: "a" } })).rejects.toThrow("step_budget_exhausted");
    const collected = await session.collect();
    expect(collected.state).toEqual({ a: 40, b: 2 });
    expect(collected.finalStateHash).toBe(contentHash(collected.state));
    expect(collected.events.map(event => event.operation)).toEqual(["create", "reset", "step", "step", "step", "step", "collect"]);
    expect(collected.events[4]).toMatchObject({ beforeStateHash: collected.finalStateHash, afterStateHash: collected.finalStateHash, error: "environment_invalid_arguments" });
    expect(collected.events[3]?.arguments).toEqual({ id: "a", value: 40 });
    collected.state.a = 500;
    expect((await session.collect()).state.a).toBe(40);
  } finally { await session.destroy(); }
  await expect(session.collect()).rejects.toThrow("environment_closed");
  await session.destroy();
  await expect(createJavaScriptEnvironmentSession({ ...input, asset: { ...input.asset, text: `${source}\n// substituted` } })).rejects.toThrow();
});

// Declared read-only actions cannot mutate state, and an environment cannot
// acquire host APIs or nondeterministic clock/random inputs from the interpreter.
test("rejects state mutation by read tools and confines environment code", async () => {
  const session = await createJavaScriptEnvironmentSession(fixture(source.replace("if (action.name === 'read') return", "if (action.name === 'read') { state.a = 99; } if (action.name === 'read') return")));
  try {
    await expect(session.step({ name: "read", arguments: { id: "a" } })).rejects.toThrow("environment_read_changed_state");
    expect((await session.collect()).state).toEqual({ a: 1, b: 2 });
  } finally { await session.destroy(); }
  const execute = (source: string, timeoutMs = 1_000) => executeJavaScriptEnvironment({ source, operation: "step", value: {}, timeoutMs });
  expect(await execute("export function step() { return { state: {}, observation: { absent: ['process','fetch','require','Date','setTimeout'].every(key => typeof globalThis[key] === 'undefined') } }; }")).toMatchObject({ observation: { absent: true } });
  await expect(execute("export function step() { return { state: {}, observation: { value: Math.random() } }; }")).rejects.toThrow("explicit_seed");
  await expect(execute("import fs from 'node:fs'; export function step() { return fs.readFileSync('/etc/passwd'); }")).rejects.toThrow();
  await expect(execute("export function step() { for (;;) {} }", 40)).rejects.toThrow();
});

// A model's claimed final state is not execution evidence. Tool observations
// must come from real steps, and exhausted/cancelled episodes cannot complete.
test("runs the policy through declared tools and retains independent state evidence", async () => {
  let turn = 0;
  const result = await runJavaScriptEnvironmentAttempt({ ...fixture(), taskId: "update-a", instructions: "Update only the requested record using tools.", timeoutMs: 5_000,
    policy: async ({ messages }) => {
      if (turn === 0) {
        expect(JSON.stringify(messages)).not.toContain('"b":2');
        expect(JSON.stringify(messages)).not.toContain("outside_scope");
        turn++;
        return { text: "", toolCalls: [{ id: "unknown", name: "bypass", arguments: {} }] };
      }
      if (turn === 1) {
        expect(messages.at(-1)).toMatchObject({ role: "tool", observation: { error: "unknown_tool" } });
        turn++;
        return { text: "", toolCalls: [{ id: "denied", name: "update", arguments: { id: "b", value: 90 } }] };
      }
      if (turn === 2) {
        expect(messages.at(-1)).toMatchObject({ role: "tool", observation: { error: "outside_scope" } });
        turn++;
        return { text: "", toolCalls: [{ id: "allowed", name: "update", arguments: { id: "a", value: 40 } }] };
      }
      return { text: '{"a":40,"b":90}', toolCalls: [] };
    },
  });
  expect(result).toMatchObject({ status: "completed", collected: true, environmentCleanupComplete: true, snapshot: { state: { a: 40, b: 2 } } });
  const { contentHash: hash, ...content } = result;
  expect(hash).toBe(contentHash(content));
  const exhausted = await runJavaScriptEnvironmentAttempt({ ...fixture(), taskId: "too-many-calls", instructions: "Read records.", timeoutMs: 5_000,
    policy: async () => ({ text: "", toolCalls: Array.from({ length: 5 }, (_, index) => ({ id: String(index), name: "read", arguments: { id: "a" } })) }),
  });
  expect(exhausted).toMatchObject({ status: "budget_exhausted", collected: false, environmentCleanupComplete: true, output: null });
  const controller = new AbortController();
  const cancelled = await runJavaScriptEnvironmentAttempt({ ...fixture(), taskId: "cancelled", instructions: "Read records.", timeoutMs: 5_000, signal: controller.signal,
    policy: async () => { controller.abort(new Error("cancelled by owner")); return { text: "claim success", toolCalls: [] }; },
  });
  expect(cancelled).toMatchObject({ status: "cancelled", collected: false, environmentCleanupComplete: true, output: null });
});
