import { describe, expect, test } from "vitest";
import type { TaskCreationSnapshot } from "@openpond/contracts";
import { readFile } from "node:fs/promises";
import { shouldCancelCreationOnDialogDismiss } from "../apps/web/src/components/create-improve/create-improve-authoring-cancellation";

describe("Create/Improve authoring cancellation", () => {
  test.each([
    "awaiting_disclosure_approval",
    "planning",
    "recommendation_ready",
    "awaiting_materialization_approval",
    "materializing",
  ] as const)("cancels durable %s work when the dialog is dismissed", (state) => {
    const creation = taskCreation(state);
    expect(shouldCancelCreationOnDialogDismiss(creation)).toBe(true);
  });

  test.each(["cancelled", "failed", "ready"] as const)(
    "does not recancel terminal %s work",
    (state) => {
      expect(shouldCancelCreationOnDialogDismiss(taskCreation(state))).toBe(false);
    },
  );

  test("treats a pre-durable request as having no run to cancel yet", () => {
    expect(shouldCancelCreationOnDialogDismiss(null)).toBe(false);
  });

  test("resets the dismissal sentinel when Strict Mode replays the effect", async () => {
    const source = await readFile(
      "apps/web/src/components/create-improve/CreateImproveAuthoringDialog.tsx",
      "utf8",
    );
    expect(source).toContain("dialogDismissedRef.current = false");
  });
});

function taskCreation(state: TaskCreationSnapshot["state"]): TaskCreationSnapshot {
  return {
    id: "creation_1",
    state,
  } as TaskCreationSnapshot;
}
