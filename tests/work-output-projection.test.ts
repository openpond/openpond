import { expect, test } from "vitest";
import type { RuntimeEvent } from "@openpond/contracts";
import { workOutputsFromEvents } from "../apps/web/src/lib/work-output-projection";

// Streaming must not rewalk old command payloads or resurrect a deleted output;
// only validated references, including later revisions, may become sidebar files.
test("reuses immutable event outputs while preserving validation and deletion history", () => {
  const file = (revision: number) => ({
    kind: "file", id: "report", title: "Report", revision,
    sourceTaskId: "task", sourceTurnId: "turn", createdAt: "2026-11-09T00:00:00Z",
    contentType: "text/plain", sizeBytes: 10, sha256: "a".repeat(64),
    location: { kind: "local", path: "outputs/report.txt", deviceId: "device" },
  });
  let payloadReads = 0;
  const publish = event("publish", {
    get payload() {
      payloadReads++;
      return { outputs: [file(1), file(1), { ...file(2), sha256: "invalid" }],
        command: { stdout: Array.from({ length: 2_000 }, (_, index) => `line ${index}`) } };
    },
  });
  expect(workOutputsFromEvents([publish])).toMatchObject([{ id: "report", revision: 1 }]);
  expect(payloadReads).toBe(1);
  const read = { ...event("read", {}), action: "work_output_read" };
  Object.defineProperty(read, "data", { get() { throw new Error("Read payloads must not be inspected"); } });
  const next = event("revision", { output: file(2) });
  expect(workOutputsFromEvents([publish, read, next])).toMatchObject([
    { id: "report", revision: 2 }, { id: "report", revision: 1 },
  ]);
  expect(payloadReads).toBe(1);
  const deleted = { ...event("delete", { output: file(1) }), action: "work_output_delete", status: "completed" as const };
  expect(workOutputsFromEvents([publish, read, next, deleted, event("replay", { output: file(1) })]))
    .toMatchObject([{ id: "report", revision: 2 }]);
  expect(payloadReads).toBe(1);
});

function event(id: string, data: unknown): RuntimeEvent {
  return { id, name: "workspace_action_result", source: "server", timestamp: "2026-11-09T00:00:00Z", data };
}
