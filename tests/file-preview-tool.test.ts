import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createByokTurnRunnerHarness } from "./helpers/byok-turn-runner-harness";
import { createFilePreviewTool } from "../apps/server/src/openpond/file-preview-tool";
import { turnRunnerTestSession } from "./helpers/turn-runner-test-harness";
import type { ModelToolExecutionContext } from "../apps/server/src/openpond/model-tool-registry";
import type { RuntimeEvent } from "@openpond/contracts";

// Native bridges have separate coverage. The shared hosted/BYOK execution loop
// must also expose and execute the tool, preserving the literal filesystem path.
test.each(["openpond", "openrouter"] as const)("%s requests an existing file preview through the shared tool loop", async providerId => {
  const cwd = await mkdtemp(join(tmpdir(), "openpond-preview-"));
  const target = join(cwd, "Report%20literal.pdf");
  await writeFile(target, "%PDF-1.4\nreport\n%%EOF");
  const harness = createByokTurnRunnerHarness({ providerId, sessionOverrides: { workspaceKind: "local_project", cwd },
    toolCallsByPass: { 1: [{ name: "openpond_show_file", args: { path: target } }] } });
  try {
    const turn = await harness.runner.sendTurn("session_1", { prompt: "Show the report." });
    expect(turn.error).toBeNull();
    expect(harness.events.filter(event => event.name === "file.preview_requested"))
      .toEqual([expect.objectContaining({ sessionId: "session_1", turnId: turn.id, source: "server",
        data: { target: "local", path: target, source: false } })]);
  } finally { await harness.runner.close(); await rm(cwd, { recursive: true, force: true }); }
});

// A model cannot redirect a preview into another chat/sandbox, escape its
// sandbox path, or issue a reveal after the originating turn was cancelled.
test("preview requests remain scoped and cancelled requests emit nothing", async () => {
  const events: RuntimeEvent[] = [];
  const tool = createFilePreviewTool({ resolveCwd: async () => null, appendEvent: async event => { events.push(event); } });
  const controller = new AbortController();
  const context = { session: turnRunnerTestSession({ workspaceKind: "sandbox", workspaceId: "sandbox-owned" }),
    turnId: "turn-owned", callId: "preview", signal: controller.signal,
    args: { path: "outputs/report.pdf", sandboxId: "other", sessionId: "other" } } as ModelToolExecutionContext;
  await tool.execute(context);
  expect(events).toEqual([expect.objectContaining({ sessionId: context.session.id, turnId: "turn-owned",
    data: { target: "sandbox", sandboxId: "sandbox-owned", path: "/workspace/outputs/report.pdf", source: false } })]);
  await expect(tool.execute({ ...context, args: { path: "../../etc/passwd" } })).rejects.toThrow("/workspace");
  controller.abort();
  await expect(tool.execute(context)).rejects.toThrow();
  expect(events).toHaveLength(1);
});
