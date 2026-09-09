import { expect, test, vi } from "vitest";
import type { LearningCommand } from "openpond-sdk/learning";
import { ApiRequestError } from "./api-client";
import { executeHostedLearningCommand } from "./hosted-learning-command";

// Worker observations change the revision independently of the UI. Retrying a
// cancellation must neither duplicate an uncertain write nor cancel a new run.
test("retries confirmed cancellation conflicts while preserving uncertain requests and iteration identity", async () => {
  const requested: LearningCommand = { action: "cancel_iteration", operationId: "original", iterationId: "selected", expectedRevision: 1 };
  const pending: { current: LearningCommand | null } = { current: null };
  const overview = vi.fn().mockResolvedValueOnce({ iteration: { id: "selected", revision: 4 } })
    .mockResolvedValueOnce({ iteration: { id: "selected", revision: 5 } });
  const command = vi.fn().mockRejectedValueOnce(new ApiRequestError("learning_revision_conflict: changed", 409))
    .mockRejectedValueOnce(new Error("connection lost"));
  await expect(executeHostedLearningCommand({ overview, command }, pending, requested, "policy")).rejects.toThrow("connection lost");
  expect(command.mock.calls[0]?.[0]).toEqual({ ...requested, expectedRevision: 4 });
  const uncertain = command.mock.calls[1]?.[0];
  expect(uncertain).toMatchObject({ iterationId: "selected", expectedRevision: 5 });
  expect(uncertain.operationId).not.toBe(requested.operationId);
  expect(pending.current).toBe(uncertain);
  command.mockResolvedValueOnce({});
  await executeHostedLearningCommand({ overview, command }, pending, requested, "policy");
  expect(command.mock.calls[2]?.[0]).toBe(uncertain);
  expect(overview).toHaveBeenCalledTimes(2);
  expect(pending.current).toBeNull();

  overview.mockResolvedValueOnce({ iteration: { id: "replacement", revision: 9 } });
  await expect(executeHostedLearningCommand({ overview, command }, pending, requested, "policy")).rejects.toThrow("selected iteration changed");
  expect(command).toHaveBeenCalledTimes(3);
});
