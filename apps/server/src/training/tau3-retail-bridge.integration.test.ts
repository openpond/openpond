import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

import { afterEach, describe, expect, it } from "vitest";

const ROOT = process.env.OPENPOND_TAU3_BENCH_ROOT?.trim() || "/tmp/tau3-bench";
const PYTHON = path.join(ROOT, ".venv", "bin", "python");
const TASKS = path.join(ROOT, "data", "tau2", "domains", "retail", "tasks.json");
const BRIDGE = path.resolve(import.meta.dirname, "tau3-retail-bridge.py");
const GRADER = "tau3-retail-outcome-rubric-v3";
const available = existsSync(PYTHON) && existsSync(TASKS);

type Action = { name: string; arguments: Record<string, unknown> };
type Step = {
  toolResults: Array<{ output: unknown }>;
  userMessage: string | null;
  terminal: boolean;
  terminationReason: string | null;
  components: Record<string, number>;
};

const children = new Set<BridgeProcess>();

afterEach(async () => {
  await Promise.all([...children].map((child) => child.close()));
  children.clear();
});

describe.runIf(available)("tau3 Retail v3 bridge fixtures", () => {
  it("scores an exact multi-mutation trajectory only after explicit confirmations", async () => {
    const bridge = await start("16");
    const actions = taskActions("16");
    for (const action of actions.slice(0, 6)) await bridge.tool(action);
    for (const action of actions.slice(6)) {
      const confirmation = await bridge.text("I have summarized this exact change. Shall I proceed?");
      expect(confirmation.userMessage).toMatch(/^Yes,/);
      await bridge.tool(action);
    }
    const result = await bridge.text("The two cancellations and watch return are complete; the refund total is 8276.23.");
    expect(result).toMatchObject({ terminal: true, terminationReason: "agent_stop" });
    expect(result.components).toMatchObject({
      terminalState: 1,
      requiredWriteCoverage: 1,
      requiredReadCoverage: 1,
      prematureMutation: 0,
      unexpectedMutation: 0,
      invalidToolRate: 0,
      resolvedCommunication: 1,
    });
  });

  it("preserves partial read evidence without claiming terminal success", async () => {
    const bridge = await start("16");
    await bridge.tool(taskActions("16")[0]!);
    const result = await bridge.text("I could not finish the request.");
    expect(result.components.terminalState).toBe(0);
    expect(result.components.requiredReadCoverage).toBeGreaterThan(0);
    expect(result.components.requiredReadCoverage).toBeLessThan(1);
    expect(result.components.requiredWriteCoverage).toBe(0);
  });

  it("records invalid tool attempts as trajectory evidence", async () => {
    const bridge = await start("65");
    const invalid = await bridge.request<Step>({
      operation: "step",
      content: null,
      toolCalls: [{ id: "invalid", name: "not_a_retail_tool", arguments: {} }],
    });
    expect(invalid.toolResults[0]?.output).toMatchObject({ error: expect.any(String) });
    const result = await bridge.text("I could not complete the request.");
    expect(result.components).toMatchObject({ toolValidity: 0, invalidToolRate: 1 });
  });

  it("detects a confirmation-required mutation performed prematurely", async () => {
    const bridge = await start("16");
    await bridge.tool(taskActions("16")[6]!);
    const result = await bridge.text("The cancellation is complete.");
    expect(result.components.prematureMutation).toBe(1);
  });

  it("detects an authorized but unexpected mutation independently", async () => {
    const bridge = await start("23");
    const confirmation = await bridge.text("I can cancel pending order #W3561391. Shall I proceed?");
    expect(confirmation.userMessage).toMatch(/^Yes,/);
    await bridge.tool({
      name: "cancel_pending_order",
      arguments: { order_id: "#W3561391", reason: "no longer needed" },
    });
    const result = await bridge.text("The order was cancelled.");
    expect(result.components).toMatchObject({ unexpectedMutation: 1, prematureMutation: 0 });
  });

  it("honors a task-authored refusal rather than synthesizing universal consent", async () => {
    const bridge = await start("24");
    const confirmation = await bridge.text("I can cancel the grill. Shall I proceed?");
    expect(confirmation.userMessage).toMatch(/^No,/);
  });

  it("marks no-read/no-write tasks as inapplicable rather than auto-covered", async () => {
    const bridge = await start("24");
    const result = await bridge.text("I kept the grill and explained the two shirts and materials.");
    expect(result.components).toMatchObject({
      terminalState: 1,
      requiredWriteCoverage: 0,
      requiredReadCoverage: 0,
      requiredWritesApplicable: 0,
      requiredReadsApplicable: 0,
      toolValidityApplicable: 0,
    });
  });

  it("makes maximum-turn termination explicit and ineligible for terminal-state credit", async () => {
    const bridge = await start("65");
    const result = await bridge.request<Step>({ operation: "terminate", reason: "max_turns" });
    expect(result).toMatchObject({ terminal: true, terminationReason: "max_turns" });
    expect(result.components).toMatchObject({ terminalState: 0, resolvedCommunication: 0 });
  });
});

async function start(taskId: string): Promise<BridgeProcess> {
  const bridge = new BridgeProcess(taskId);
  children.add(bridge);
  await bridge.request({ operation: "init" });
  return bridge;
}

function taskActions(taskId: string): Action[] {
  const tasks = JSON.parse(readFileSync(TASKS, "utf8")) as Array<{
    id: string;
    evaluation_criteria: { actions: Action[] };
  }>;
  const task = tasks.find((candidate) => String(candidate.id) === taskId);
  if (!task) throw new Error(`Missing tau3 fixture task ${taskId}.`);
  return task.evaluation_criteria.actions;
}

class BridgeProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly reader: readline.Interface;
  private readonly pending: Array<{
    resolve(value: unknown): void;
    reject(error: Error): void;
  }> = [];
  private stderr = "";
  private closed = false;

  constructor(taskId: string) {
    this.child = spawn(PYTHON, [BRIDGE, taskId, GRADER], {
      cwd: ROOT,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.reader = readline.createInterface({ input: this.child.stdout });
    this.reader.on("line", (line) => {
      const waiter = this.pending.shift();
      if (!waiter) return;
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        if (value.fatal) throw new Error(String(value.message ?? value.fatal));
        waiter.resolve(value);
      } catch (error) {
        waiter.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-4_000);
    });
    this.child.on("exit", (code) => {
      this.closed = true;
      for (const waiter of this.pending.splice(0)) {
        waiter.reject(new Error(`tau3 bridge exited ${code}: ${this.stderr}`));
      }
    });
  }

  tool(action: Action): Promise<Step> {
    return this.request({
      operation: "step",
      content: null,
      toolCalls: [{ id: `call-${crypto.randomUUID()}`, ...action }],
    });
  }

  text(content: string): Promise<Step> {
    return this.request({ operation: "step", content, toolCalls: [] });
  }

  request<T = Record<string, unknown>>(value: Record<string, unknown>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push({ resolve: (result) => resolve(result as T), reject });
      this.child.stdin.write(`${JSON.stringify(value)}\n`, (error) => {
        if (error) reject(error);
      });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.child.stdin.end();
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.child.kill("SIGTERM");
        resolve();
      }, 2_000);
      this.child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
}
