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
  test("allows Work to dispatch a grader audit while keeping Taskset tools out of Chat", async () => {
    const calls: unknown[] = [];
    const definitions = createDatasetBuilderModelToolDefinitions((context, action, payload) =>
      executeHostedTasksetAction({
        session: context.session,
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
    const result = await audit!.execute({
      session: session(),
      turnId: "turn_test",
      turnPermissions: {},
      provider: "openpond",
      model: "model_test",
      callId: "audit_once",
      args: { action: "audit_graders", tasksetId: "taskset_test", split: "train", taskLimit: 1, attemptsPerTask: 1 },
      signal: new AbortController().signal,
      workspaceDiffBaseline: null,
      mentionedApps: [],
      userPrompt: "Audit the published Taskset's graders once.",
      turnMetadata: {},
    });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ path: "/hosted-tasksets/actions", method: "POST",
      body: { action: "audit_graders", tasksetId: "taskset_test", split: "train", taskLimit: 1, attemptsPerTask: 1 } });
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
        provider: "openpond",
        model: "model_test",
        action: "status",
        payload: {},
        request: async () => ({ ok: true }),
      }),
    ).rejects.toThrow("bound Work workspace");
  });
});
