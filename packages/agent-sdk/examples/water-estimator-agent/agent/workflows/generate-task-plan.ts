import { defineIntent, defineWorkflow, type AgentChatInput } from "openpond-agent-sdk";
import { z } from "zod";

const DrawingTaskPlanInput = z.object({
  prompt: z.string(),
  files: z.array(z.object({ ref: z.string() })).default([]),
  context: z.record(z.string(), z.unknown()).optional(),
});

export const generateTaskPlanWorkflow = defineWorkflow({
  name: "generate-task-plan",
  description: "Render drawings, extract sheet/task data, consolidate tasks, and export CSV/XLSX.",
  async run(ctx, input) {
    ctx.trace.event("task_plan.render_drawings.started", { fileCount: files(input).length });
    await ctx.runCommand("bun run render-drawings", { input });
    ctx.trace.artifact("artifacts/drawing-render-manifest.json");
    ctx.trace.artifact("artifacts/drawing-rendered-pages.csv");

    await ctx.runCommand("bun run extract-sheet-index", { input });
    ctx.trace.artifact("artifacts/sheet-index.json");

    await ctx.runCommand("bun run extract-page-tasks", { input });
    ctx.trace.artifact("artifacts/page-extractions.json");

    await ctx.runCommand("bun run consolidate-task-plan", { input });
    ctx.trace.artifact("artifacts/consolidated-task-plan.json");

    await ctx.runCommand("bun run export-task-plan", { input });
    ctx.trace.artifact("artifacts/task-plan.xlsx");

    return {
      text: "OpenPond generated the drawing task plan. The XLSX and source artifacts are ready for review.",
      intent: "generate_task_plan",
      artifactRefs: [
        "artifacts/drawing-render-manifest.json",
        "artifacts/sheet-index.json",
        "artifacts/page-extractions.json",
        "artifacts/consolidated-task-plan.json",
        "artifacts/task-plan.csv",
        "artifacts/task-plan.xlsx",
        "artifacts/task-plan-export.json",
        "artifacts/task-plan-ledger.json",
      ],
    };
  },
});

export const generateTaskPlanIntent = defineIntent<AgentChatInput>({
  name: "generate_task_plan",
  description: "Generate a construction task plan from drawing PDFs or drawing links.",
  inputSchema: DrawingTaskPlanInput,
  when(input) {
    return hasAnyDrawing(input);
  },
  async run(ctx, input) {
    return ctx.workflow("generate-task-plan", input);
  },
});

function hasAnyDrawing(input: AgentChatInput): boolean {
  return files(input).some((file) => {
    const haystack = `${file.name ?? ""} ${file.mimeType ?? ""} ${file.ref}`.toLowerCase();
    const hasDrawingCue =
      haystack.includes("drawing") ||
      haystack.includes("plan") ||
      haystack.includes("sheet") ||
      haystack.includes("blueprint");
    const isPdf = haystack.includes(".pdf") || haystack.includes("application/pdf");
    return hasDrawingCue && isPdf;
  });
}

function files(input: unknown): Array<{ ref: string; name?: string; mimeType?: string }> {
  const record = input as { files?: Array<{ ref: string; name?: string; mimeType?: string }> };
  return record.files ?? [];
}
