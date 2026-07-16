import { defineWorkflow } from "openpond-agent-sdk";

export const renderDrawingsWorkflow = defineWorkflow({
  name: "render-drawings",
  description: "Render drawing PDFs into page images and a render manifest.",
  async run(ctx, input) {
    await ctx.runCommand("pnpm render-drawings", { input });
    return {
      text: "Rendered drawing pages.",
      artifactRefs: [
        "artifacts/drawing-render-manifest.json",
        "artifacts/drawing-rendered-pages.csv",
      ],
    };
  },
});

export const extractSheetIndexWorkflow = defineWorkflow({
  name: "extract-sheet-index",
  description: "Extract sheet index metadata from rendered drawing pages.",
  async run(ctx, input) {
    await ctx.runCommand("pnpm extract-sheet-index", { input });
    return {
      text: "Extracted sheet index.",
      artifactRefs: ["artifacts/sheet-index.json"],
    };
  },
});

export const extractPageTasksWorkflow = defineWorkflow({
  name: "extract-page-tasks",
  description: "Extract page-level task candidates from drawings.",
  async run(ctx, input) {
    await ctx.runCommand("pnpm extract-page-tasks", { input });
    return {
      text: "Extracted page task candidates.",
      artifactRefs: ["artifacts/page-extractions.json"],
    };
  },
});

export const consolidateTaskPlanWorkflow = defineWorkflow({
  name: "consolidate-task-plan",
  description: "Consolidate page-level extractions into one task plan.",
  async run(ctx, input) {
    await ctx.runCommand("pnpm consolidate-task-plan", { input });
    return {
      text: "Consolidated task plan.",
      artifactRefs: ["artifacts/consolidated-task-plan.json"],
    };
  },
});

export const exportTaskPlanWorkflow = defineWorkflow({
  name: "export-task-plan",
  description: "Export a consolidated task plan to CSV, XLSX, and ledger artifacts.",
  async run(ctx, input) {
    await ctx.runCommand("pnpm export-task-plan", { input });
    return {
      text: "Exported task plan.",
      artifactRefs: [
        "artifacts/task-plan.csv",
        "artifacts/task-plan.xlsx",
        "artifacts/task-plan-export.json",
        "artifacts/task-plan-ledger.json",
      ],
    };
  },
});
