import { defineTool } from "openpond-agent-sdk";

export const waterEstimatorTools = [
  defineTool({
    name: "generate_task_plan",
    description: "Generate a construction drawing task plan from uploaded drawing PDFs.",
    visibility: "end_user",
    target: {
      kind: "action",
      action: "generate-task-plan",
      workflow: "generate-task-plan",
    },
    inputSchema: "DrawingTaskPlanInput",
    outputArtifacts: [
      "artifacts/consolidated-task-plan.json",
      "artifacts/task-plan.csv",
      "artifacts/task-plan.xlsx",
    ],
  }),
  defineTool({
    name: "review_water_estimate",
    description: "Review a proposal against historical water estimate files.",
    visibility: "end_user",
    target: {
      kind: "action",
      action: "generate-estimate",
      workflow: "generate-estimate-review",
    },
    inputSchema: "EstimateReviewInput",
    outputArtifacts: [
      "artifacts/example-estimate.json",
      "artifacts/example-estimate.xlsx",
      "artifacts/proposal-review.json",
    ],
  }),
  defineTool({
    name: "revise_task_plan",
    description: "Approve, reject, export, rename, or edit an existing task plan.",
    visibility: "end_user",
    target: {
      kind: "action",
      action: "revise-task-plan",
      workflow: "task-plan-revision",
    },
    inputSchema: "TaskPlanRevisionInput",
    outputArtifacts: [
      "artifacts/task-plan-revision.json",
      "artifacts/task-plan-v2.xlsx",
      "artifacts/task-plan-approved.xlsx",
    ],
  }),
  defineTool({
    name: "lookup_task_plan_history",
    description: "Search saved task-plan history stored on the durable water-history volume.",
    visibility: "end_user",
    target: {
      kind: "action",
      action: "task-plan-history",
      workflow: "task-plan-history",
    },
    inputSchema: "TaskPlanHistoryInput",
    outputArtifacts: [
      "artifacts/task-plan-history-answer.json",
      "artifacts/task-plan-history-candidates.json",
    ],
  }),
  defineTool({
    name: "render_drawings",
    description: "Render drawing PDFs to page images for debugging extraction behavior.",
    visibility: "debug",
    target: {
      kind: "action",
      action: "render-drawings",
    },
    outputArtifacts: [
      "artifacts/drawing-render-manifest.json",
      "artifacts/drawing-rendered-pages.csv",
    ],
  }),
  defineTool({
    name: "extract_sheet_index",
    description: "Build the drawing sheet index from rendered pages and drawing metadata.",
    visibility: "debug",
    target: {
      kind: "action",
      action: "extract-sheet-index",
    },
    outputArtifacts: ["artifacts/sheet-index.json"],
  }),
  defineTool({
    name: "extract_page_tasks",
    description: "Extract task candidates from selected rendered drawing pages.",
    visibility: "debug",
    target: {
      kind: "action",
      action: "extract-page-tasks",
    },
    outputArtifacts: ["artifacts/page-extractions.json"],
  }),
  defineTool({
    name: "export_task_plan",
    description: "Export the consolidated task plan to CSV/XLSX.",
    visibility: "debug",
    target: {
      kind: "action",
      action: "export-task-plan",
    },
    outputArtifacts: [
      "artifacts/task-plan.csv",
      "artifacts/task-plan.xlsx",
      "artifacts/task-plan-export.json",
      "artifacts/task-plan-ledger.json",
    ],
  }),
];
