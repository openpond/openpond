import { describe, expect, test } from "vitest";

import { buildHostedRunIdempotencyKey } from "../packages/cloud/src/profile/hosted-run-idempotency";

describe("hosted run idempotency keys", () => {
  const baseInput = {
    localHead: "local_head_1",
    sourceHead: "source_head_1",
    runtimeAgentId: "runtime_agent_1",
    input: {
      channel: "openpond_chat",
      prompt: "hello",
    },
  };

  test("uses explicit hosted run idempotency keys unchanged", () => {
    expect(
      buildHostedRunIdempotencyKey({
        ...baseInput,
        explicitKey: "fixed-key",
        retry: true,
        randomId: () => "retry-id",
      }),
    ).toBe("fixed-key");
  });

  test("builds deterministic keys for equivalent hosted run inputs", () => {
    const left = buildHostedRunIdempotencyKey({
      ...baseInput,
      input: { prompt: "hello", channel: "openpond_chat" },
    });
    const right = buildHostedRunIdempotencyKey({
      ...baseInput,
      input: { channel: "openpond_chat", prompt: "hello" },
    });

    expect(left).toBe(right);
    expect(left).not.toContain(":retry:");
  });

  test("keeps different target workspace bindings idempotent separately", () => {
    const left = buildHostedRunIdempotencyKey({
      ...baseInput,
      targetProjectId: "workspace_project_1",
    });
    const right = buildHostedRunIdempotencyKey({
      ...baseInput,
      targetProjectId: "workspace_project_2",
    });

    expect(left).not.toBe(right);
    expect(left).toContain(":workspace_project_1:");
    expect(right).toContain(":workspace_project_2:");
  });

  test("adds a new retry suffix for intentional hosted run retries", () => {
    const base = buildHostedRunIdempotencyKey(baseInput);
    const retry = buildHostedRunIdempotencyKey({
      ...baseInput,
      retry: true,
      randomId: () => "retry-id-1",
    });

    expect(retry).toBe(`${base}:retry:retry-id-1`);
  });
});
