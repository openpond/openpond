import { describe, expect, test } from "vitest";
import type { FileOutputRef, RuntimeEvent } from "@openpond/contracts";
import { workOutputsFromEvents } from "../apps/web/src/components/app-shell/WorkSidebarPanel";

describe("Work sidebar output model", () => {
  test("keeps revisions and removes explicitly deleted outputs", () => {
    const first = outputRef("output_1", 1, "2026-07-28T10:00:00.000Z");
    const second = outputRef("output_1", 2, "2026-07-28T11:00:00.000Z");
    const events = [
      outputEvent("event_1", "sandbox_save_output", first),
      outputEvent("event_2", "sandbox_save_output", second),
      outputEvent("event_3", "work_output_read", second),
      outputEvent("event_4", "work_output_delete", first),
    ];

    expect(workOutputsFromEvents(events)).toEqual([second]);
  });
});

function outputRef(
  id: string,
  revision: number,
  createdAt: string
): FileOutputRef {
  return {
    kind: "file",
    id,
    title: "report.md",
    contentType: "text/markdown",
    sizeBytes: 8,
    sha256: "a".repeat(64),
    sourceTaskId: "session_work",
    sourceTurnId: `turn_${revision}`,
    revision,
    createdAt,
    location: {
      kind: "local",
      path: `/tmp/${id}-report.md`,
      deviceId: "device_1",
    },
    validation: [],
  };
}

function outputEvent(
  id: string,
  action: RuntimeEvent["action"],
  outputRef: FileOutputRef
): RuntimeEvent {
  return {
    id,
    sessionId: "session_work",
    turnId: "turn_1",
    name: "workspace_action_result",
    timestamp: outputRef.createdAt,
    source: "ui_button",
    action,
    status: "completed",
    data: { outputRef },
  };
}
