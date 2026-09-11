import { describe, expect, test } from "vitest";

import type { Session } from "@openpond/contracts";

import { executeHostedTasksetAction } from "../apps/server/src/openpond/hosted-tasksets.js";
import { createDatasetBuilderModelToolDefinitions } from "../apps/server/src/openpond/dataset-builder-tool-definitions.js";
import { filterModelToolsForExperience } from "../apps/server/src/runtime/experience-policy.js";

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "session_test",
    experience: "work",
    provider: "openpond",
    title: "Hosted Work",
    appId: null,
    appName: null,
    workspaceKind: "sandbox",
    workspaceId: "sandbox_test",
    metadata: {
      hostConversationId: "conv_test1",
      hostSandboxId: "sandbox_test",
    },
    cwd: null,
    codexThreadId: null,
    createdAt: "2026-09-10T00:00:00.000Z",
    updatedAt: "2026-09-10T00:00:00.000Z",
    status: "active",
    pinned: false,
    archived: false,
    order: 0,
    ...overrides,
  };
}

describe("hosted Taskset client", () => {
  // The client worked directly while the real Work experience filtered its tool out.
  test("dispatches Work checks with their judge cap and rejects limits that would be ignored", async () => {
    const calls: unknown[] = [];
    const definitions = createDatasetBuilderModelToolDefinitions((context, action, payload) =>
      executeHostedTasksetAction({
        session: context.session,
        turnId: context.turnId,
        callId: context.callId,
        signal: context.signal,
        provider: context.provider,
        model: context.model,
        action,
        payload,
        request: async (request) => { calls.push(request); return { id: "test_saved" }; },
      }));
    expect(filterModelToolsForExperience(session({ experience: "chat" }), definitions)).toEqual([]);
    const audit = filterModelToolsForExperience(session(), definitions)
      .find((definition) => definition.name === "openpond_dataset_test");
    expect(audit).toBeDefined();
    const context: Parameters<NonNullable<typeof audit>["execute"]>[0] = {
      session: session(),
      turnId: "turn_test",
      turnPermissions: {},
      provider: "openpond",
      model: "model_test",
      callId: "audit_once",
      args: { action: "audit_graders", tasksetId: "taskset_test", split: "train", taskLimit: 1, attemptsPerTask: 1, maximumSpendUsd: 0 },
      signal: new AbortController().signal,
      workspaceDiffBaseline: null,
      mentionedApps: [],
      userPrompt: "Audit the published Taskset's graders once.",
      turnMetadata: {},
    };
    const result = await audit!.execute(context);
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ path: "/hosted-tasksets/actions", method: "POST",
      body: { action: "audit_graders", tasksetId: "taskset_test", split: "train", taskLimit: 1, attemptsPerTask: 1, maximumSpendUsd: 0 } });
    await audit!.execute({ ...context, callId: "calibrate_once", args: {
      action: "calibrate_judges", tasksetId: "taskset_test", maximumSpendUsd: 0.05,
    } });
    expect(calls[1]).toMatchObject({ body: { action: "calibrate_judges", maximumSpendUsd: 0.05 } });
    // Silently stripping a cap, including explicit zero, could permit unbounded
    // judging. Local Taskset calibration does not implement this hosted ledger.
    for (const maximumSpendUsd of [-1, Number.NaN, "0.05"]) {
      await expect(audit!.execute({ ...context, args: { ...context.args, maximumSpendUsd } }))
        .rejects.toThrow("finite nonnegative number");
    }
    await expect(audit!.execute({ ...context, session: session({ workspaceKind: "local", metadata: {} }) }))
      .rejects.toThrow("only in hosted Work");
    expect(calls).toHaveLength(2);
  });

  test("sends a stable scoped action to the public API", async () => {
    const calls: unknown[] = [];
    const request = async (input: {
      path: string;
      method?: "GET" | "POST" | "PATCH" | "DELETE";
      body?: Record<string, unknown>;
    }) => {
      calls.push(input);
      return { ok: true };
    };
    const input = {
      session: session(),
      turnId: "turn_test",
      callId: "design_once",
      signal: new AbortController().signal,
      provider: "openpond" as const,
      model: "accounts/fireworks/models/deepseek-v4-flash",
      action: "start" as const,
      payload: {
        objective: "Build a Taskset",
        sourceIds: ["source_1"],
      },
      request,
    };

    await executeHostedTasksetAction(input);
    await executeHostedTasksetAction(input);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(calls[1]);
    expect(calls[0]).toMatchObject({
      path: "/hosted-tasksets/actions",
      method: "POST",
      body: {
        action: "start",
        objective: "Build a Taskset",
        sourceReferenceIds: ["source_1"],
      },
    });
    expect(
      (calls[0] as { body: { clientRequestId: string } }).body.clientRequestId,
    ).toMatch(/^session_test:[a-f0-9]{32}$/);
  });

  test("rejects a session whose sandbox metadata does not match its workspace", async () => {
    await expect(
      executeHostedTasksetAction({
        session: session({ workspaceId: "sandbox_forged" }),
        turnId: "turn_test",
        callId: "status_once",
        signal: new AbortController().signal,
        provider: "openpond",
        model: "model_test",
        action: "status",
        payload: {},
        request: async () => ({ ok: true }),
      }),
    ).rejects.toThrow("bound Work workspace");
  });

  // Payload hashing previously reused an old saved audit in a later user turn.
  test("keeps retries stable and distinguishes new calls while carrying cancellation and a bounded check deadline", async () => {
    const calls: Array<{ body?: Record<string, unknown>; signal?: AbortSignal; timeoutMs?: number }> = [];
    const controller = new AbortController();
    const input = {
      session: session(), turnId: "turn_one", callId: "call_one", signal: controller.signal,
      provider: "openpond" as const, model: "model_test", action: "audit_graders" as const,
      payload: { tasksetId: "taskset_test", taskLimit: 1 },
      request: async (request: (typeof calls)[number]) => { calls.push(request); return { ok: true }; },
    };
    await executeHostedTasksetAction(input);
    await executeHostedTasksetAction(input);
    await executeHostedTasksetAction({ ...input, turnId: "turn_two" });
    await executeHostedTasksetAction({ ...input, callId: "call_two" });
    await executeHostedTasksetAction({ ...input, payload: { ...input.payload, taskLimit: 2 } });
    const ids = calls.map(call => call.body?.clientRequestId);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
    expect(ids[3]).not.toBe(ids[0]);
    // The API can reject changed inputs under one operation instead of admitting
    // another potentially paid execution with a different request hash.
    expect(ids[4]).toBe(ids[0]);
    expect(calls[4]?.body?.taskLimit).toBe(2);
    expect(calls[0]?.timeoutMs).toBe(30_000);
    expect(calls[0]?.signal?.aborted).toBe(false);
    controller.abort(new Error("cancelled before dispatch"));
    await expect(executeHostedTasksetAction(input)).rejects.toThrow("cancelled before dispatch");
    expect(calls).toHaveLength(5);
    const duringResponse = new AbortController();
    await expect(executeHostedTasksetAction({
      ...input,
      signal: duringResponse.signal,
      request: async () => {
        duringResponse.abort(new Error("cancelled during response"));
        return { ok: true };
      },
    })).rejects.toThrow("cancelled during response");
  });

  // A long HTTP request was cut off by the public edge while the backend kept
  // staging files. Polling must never become a second grading operation.
  test("polls one durable identity and returns its stored result", async () => {
    const calls: Array<{ body?: Record<string, unknown>; timeoutMs?: number }> = [];
    const saved = { ok: true, action: "audit_graders", result: { id: "saved_check", result: { valid: true } } };
    const result = await executeHostedTasksetAction({
      session: session(), turnId: "turn_poll", callId: "call_poll", signal: new AbortController().signal,
      provider: "openpond", model: "model_test", action: "audit_graders", payload: { tasksetId: "taskset_test", maximumSpendUsd: 0 },
      request: async request => {
        calls.push(request);
        return calls.length < 3 ? { ok: true, result: { schemaVersion: "openpond.hostedTasksetOperation.v1", id: "operation_one",
          status: calls.length === 1 ? "queued" : "running", retryAfterMs: 1 } } : saved;
      },
    });
    expect(result).toEqual(saved);
    expect(calls).toHaveLength(3);
    expect(calls.every(call => JSON.stringify(call.body) === JSON.stringify(calls[0]!.body))).toBe(true);
    expect(calls.every(call => call.timeoutMs === 30_000)).toBe(true);
  });

  test("cancels a waiting operation by the same identity without resubmitting work", async () => {
    const cancellation = new AbortController();
    const bodies: Array<Record<string, unknown> | undefined> = [];
    await expect(executeHostedTasksetAction({
      session: session(), turnId: "turn_cancel", callId: "call_cancel", signal: cancellation.signal,
      provider: "openpond", model: "model_test", action: "calibrate_judges", payload: { tasksetId: "taskset_test", maximumSpendUsd: 0.01 },
      request: async request => {
        bodies.push(request.body);
        if (request.body?.cancelCheck) {
          expect(request.signal?.aborted).toBe(false);
          return { ok: true };
        }
        setTimeout(() => cancellation.abort(new Error("user cancelled check")), 5);
        return { ok: true, result: { schemaVersion: "openpond.hostedTasksetOperation.v1", id: "operation_cancel", status: "running", retryAfterMs: 1000 } };
      },
    })).rejects.toThrow("user cancelled check");
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual({ ...bodies[0], cancelCheck: true });
  });
});
