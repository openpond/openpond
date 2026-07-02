import { action } from "openpond-agent-sdk";

import { waterEstimatorChatRouter } from "./workflows/chat";
import { generateEstimateReviewWorkflow } from "./workflows/generate-estimate-review";
import { generateTaskPlanWorkflow } from "./workflows/generate-task-plan";
import {
  consolidateTaskPlanWorkflow,
  exportTaskPlanWorkflow,
  extractPageTasksWorkflow,
  extractSheetIndexWorkflow,
  renderDrawingsWorkflow,
} from "./workflows/task-plan-steps";
import { taskPlanHistoryWorkflow } from "./workflows/task-plan-history";
import { taskPlanRevisionWorkflow } from "./workflows/task-plan-revision";

const taskPlanArtifacts = [
  "artifacts/drawing-render-manifest.json",
  "artifacts/drawing-rendered-pages.csv",
  "artifacts/sheet-index.json",
  "artifacts/page-extractions.json",
  "artifacts/consolidated-task-plan.json",
  "artifacts/task-plan.csv",
  "artifacts/task-plan.xlsx",
  "artifacts/task-plan-export.json",
  "artifacts/task-plan-ledger.json",
];

const estimateArtifacts = [
  "artifacts/example-estimate.json",
  "artifacts/example-estimate.csv",
  "artifacts/example-estimate.xlsx",
  "artifacts/search-results.json",
  "artifacts/proposal-review.json",
  "artifacts/sqlite-import-summary.json",
];

const revisionArtifacts = [
  "artifacts/task-plan-revision.json",
  "artifacts/task-plan-v2.csv",
  "artifacts/task-plan-v2.xlsx",
  "artifacts/task-plan-approved.csv",
  "artifacts/task-plan-approved.xlsx",
];

export const waterEstimatorActions = [
  action("chat", {
    description: "Shared conversational entrypoint for OpenPond Chat, Teams, Slack, MCP, API, and schedules.",
    target: {
      kind: "intent-router",
      router: waterEstimatorChatRouter,
    },
    visibility: "default",
    timeoutSeconds: 10800,
    outputArtifacts: [
      "artifacts/chat-result.json",
      "artifacts/openpond-trace.jsonl",
      ...taskPlanArtifacts,
      ...estimateArtifacts,
      "artifacts/microsoft-upload-refs.json",
      "artifacts/task-plan-history-answer.json",
      "artifacts/task-plan-history-candidates.json",
      ...revisionArtifacts,
    ],
  }),
  action("generate-task-plan", {
    description: "Generate a task plan from drawing PDFs.",
    target: {
      kind: "workflow",
      workflow: generateTaskPlanWorkflow,
    },
    visibility: "end_user",
    timeoutSeconds: 10800,
    inputSchema: "DrawingTaskPlanInput",
    outputArtifacts: taskPlanArtifacts,
  }),
  action("render-drawings", {
    description: "Render drawing PDFs into page images.",
    target: {
      kind: "workflow",
      workflow: renderDrawingsWorkflow,
    },
    visibility: "debug",
    timeoutSeconds: 1800,
    outputArtifacts: [
      "artifacts/drawing-render-manifest.json",
      "artifacts/drawing-rendered-pages.csv",
    ],
  }),
  action("extract-sheet-index", {
    description: "Extract drawing sheet metadata from rendered pages.",
    target: {
      kind: "workflow",
      workflow: extractSheetIndexWorkflow,
    },
    visibility: "debug",
    timeoutSeconds: 1800,
    outputArtifacts: ["artifacts/sheet-index.json"],
  }),
  action("extract-page-tasks", {
    description: "Extract task candidates from selected drawing pages.",
    target: {
      kind: "workflow",
      workflow: extractPageTasksWorkflow,
    },
    visibility: "debug",
    timeoutSeconds: 7200,
    outputArtifacts: ["artifacts/page-extractions.json"],
  }),
  action("consolidate-task-plan", {
    description: "Merge page-level extraction results into one task plan.",
    target: {
      kind: "workflow",
      workflow: consolidateTaskPlanWorkflow,
    },
    visibility: "debug",
    timeoutSeconds: 1800,
    outputArtifacts: ["artifacts/consolidated-task-plan.json"],
  }),
  action("export-task-plan", {
    description: "Export a consolidated task plan to CSV/XLSX and ledger files.",
    target: {
      kind: "workflow",
      workflow: exportTaskPlanWorkflow,
    },
    visibility: "debug",
    timeoutSeconds: 1800,
    outputArtifacts: [
      "artifacts/consolidated-task-plan.json",
      "artifacts/task-plan.csv",
      "artifacts/task-plan.xlsx",
      "artifacts/task-plan-export.json",
      "artifacts/task-plan-ledger.json",
    ],
  }),
  action("generate-estimate", {
    description: "Review a proposal against historical water estimate files.",
    target: {
      kind: "workflow",
      workflow: generateEstimateReviewWorkflow,
    },
    visibility: "end_user",
    timeoutSeconds: 3600,
    inputSchema: "EstimateReviewInput",
    outputArtifacts: estimateArtifacts,
  }),
  action("task-plan-history", {
    description: "Search saved task-plan history on the durable water-history volume.",
    target: {
      kind: "workflow",
      workflow: taskPlanHistoryWorkflow,
    },
    visibility: "end_user",
    timeoutSeconds: 1800,
    inputSchema: "TaskPlanHistoryInput",
    outputArtifacts: [
      "artifacts/task-plan-history-answer.json",
      "artifacts/task-plan-history-candidates.json",
    ],
  }),
  action("revise-task-plan", {
    description: "Approve, reject, rename, export, or revise an existing task plan.",
    target: {
      kind: "workflow",
      workflow: taskPlanRevisionWorkflow,
    },
    visibility: "end_user",
    timeoutSeconds: 1800,
    inputSchema: "TaskPlanRevisionInput",
    outputArtifacts: revisionArtifacts,
  }),
];
