import { expect, it } from "vitest";
import { createBudgetedJudgeExecutor, judgeCommittedSpend, type JudgeBudgetState, type JudgeBudgetStore } from "../src/learning/judge-budget.js";
import type { BoundJudgeRequest, BoundJudgeResponse } from "../src/learning/model-judge.js";

const request: BoundJudgeRequest = { providerId: "openai", modelId: "judge", revision: null, temperature: 0, system: "Rubric", data: "{}" };
const response: BoundJudgeResponse = { text: "{}", modelId: "judge", modelRevision: null, responseId: "response", inputTokens: 10, outputTokens: 1, costUsd: 0.02 };
function ledger(maximumSpendUsd: number) {
  const state: JudgeBudgetState = { maximumSpendUsd, calls: [] };
  const store: JudgeBudgetStore = { async transaction(_intent, update) { const next = update(structuredClone(state)); state.calls = next.calls; return next.result; } };
  return { state, store };
}

// Reservations must precede dispatch and survive both missing responses and
// cancellation, otherwise retry/concurrency can exceed a user's spend cap.
it("reserves once, replays settlement and retains the cost after cancellation", async () => {
  const { state, store } = ledger(0.05);
  let calls = 0;
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const controller = new AbortController();
  const execute = createBudgetedJudgeExecutor({ store, maximumCharge: () => 0.04, dispatch: async () => { calls++; entered(); await pending; controller.abort(); return response; } });
  const first = execute("fixture", request, controller.signal);
  await started;
  expect(judgeCommittedSpend(state.calls)).toBe(0.04);
  await expect(execute("fixture", request)).rejects.toThrow("charge_unresolved");
  await expect(execute("another", request)).rejects.toThrow("budget_exceeded");
  release();
  expect(await first).toEqual(response);
  expect(judgeCommittedSpend(state.calls)).toBe(0.02);
  expect(await execute("fixture", request)).toEqual(response);
  expect(calls).toBe(1);
  await expect(execute("fixture", { ...request, data: "changed" })).rejects.toThrow("identity_conflict");
});

it("keeps uncertain charges reserved across executor recreation and rejects a zero budget", async () => {
  const { state, store } = ledger(0.04);
  let calls = 0;
  const options = { store, maximumCharge: () => 0.04, dispatch: async () => { calls++; throw new Error("Connection lost after dispatch"); } };
  await expect(createBudgetedJudgeExecutor(options)("fixture", request)).rejects.toThrow("Connection lost");
  await expect(createBudgetedJudgeExecutor(options)("fixture", request)).rejects.toThrow("charge_unresolved");
  expect(judgeCommittedSpend(state.calls)).toBe(0.04);
  expect(calls).toBe(1);
  await expect(createBudgetedJudgeExecutor({ ...options, store: ledger(0).store })("zero", request)).rejects.toThrow("budget_exceeded");
  expect(calls).toBe(1);
});
