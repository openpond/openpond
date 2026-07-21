import { describe, expect, test } from "vitest";
import type { RuntimeEvent } from "@openpond/contracts";
import {
  createImproveConversationTitle,
  latestCreateImproveRunProjection,
} from "../apps/web/src/lib/create-pipeline-runtime";
import { createImproveRunFixture } from "./helpers/create-improve-fixtures";

describe("canonical Create/Improve projection", () => {
  test.each([
    "planning",
    "awaiting_questions",
    "awaiting_plan_approval",
    "evaluating",
    "cancelled",
    "ready_local",
  ] as const)("projects the same %s run into main and side chat", (state) => {
    const run = createImproveRunFixture({ id: `run_${state}`, state });
    const events = [createImproveEvent(run)];
    const mainProjection = latestCreateImproveRunProjection({
      messages: [{ createImproveRun: run }],
    });
    const sideProjection = latestCreateImproveRunProjection({ events });

    expect(mainProjection).toEqual(sideProjection);
    expect(sideProjection).toMatchObject({ id: run.id, revision: run.revision, state });
  });

  test("rehydrates the same in-progress run from persisted event replay", () => {
    const run = createImproveRunFixture({
      id: "run_resume",
      state: "awaiting_plan_approval",
      revision: 4,
    });
    const persisted = JSON.parse(JSON.stringify([createImproveEvent(run)])) as RuntimeEvent[];

    expect(latestCreateImproveRunProjection({ events: persisted })).toEqual(run);
  });

  test("uses the canonical Agent name without showing a lifecycle title", () => {
    expect(createImproveConversationTitle(
      createImproveRunFixture({
        target: {
          kind: "agent",
          id: "account-health-agent",
          displayName: "Account Health Agent",
          defaultActionKey: "chat",
        },
      }),
      "Create agent",
    )).toBe("Account Health Agent");
    expect(createImproveConversationTitle(
      createImproveRunFixture({
        target: {
          kind: "agent",
          id: null,
          displayName: "Create agent",
          defaultActionKey: null,
        },
      }),
      "Account health review",
    )).toBe("Account health review");
  });
});

function createImproveEvent(run: ReturnType<typeof createImproveRunFixture>): RuntimeEvent {
  return {
    id: `event_${run.id}`,
    sequence: 1,
    name: "create_improve.updated",
    sessionId: run.scope.conversationId,
    turnId: run.scope.originTurnId,
    timestamp: run.updatedAt,
    data: { createImproveRun: run },
  } as RuntimeEvent;
}
