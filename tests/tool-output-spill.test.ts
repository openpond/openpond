import { describe, expect, test } from "vitest";
import { formatWorkspaceToolResultForModel } from "../apps/server/src/openpond/hosted-tool-protocol";
import { toolOutputPreviewForCompaction, toolOutputResourceRef } from "../apps/server/src/openpond/tool-output-spill";

describe("durable tool-output spill", () => {
  test("keeps head and tail evidence while pointing the model at a pageable resource", () => {
    const output = `HEAD:${"x".repeat(20_000)}:TAIL`;
    const ref = toolOutputResourceRef("call_1");
    const rendered = formatWorkspaceToolResultForModel({
      ok: false,
      action: "sandbox_exec",
      output,
      data: { exitCode: 1 },
    }, { outputResourceRef: ref });

    expect(rendered).toContain("HEAD:");
    expect(rendered).toContain(":TAIL");
    expect(rendered).toContain(ref);
    expect(rendered).toContain('"outputSpill"');
    expect(rendered.length).toBeLessThan(output.length / 2);
  });

  test("uses the same head-tail evidence in compaction instead of a prefix-only cut", () => {
    const output = `BEGIN:${"y".repeat(12_000)}:END`;
    const preview = toolOutputPreviewForCompaction({
      output,
      resourceRef: "tool-output:call_2",
    });

    expect(preview).toContain("BEGIN:");
    expect(preview).toContain(":END");
    expect(preview).toContain("tool-output:call_2");
  });
});
