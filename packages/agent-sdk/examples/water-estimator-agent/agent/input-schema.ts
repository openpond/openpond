import type { JsonSchema } from "openpond-agent-sdk";

export const waterEstimatorInputSchema = {
  type: "object",
  properties: {
    drawingFiles: {
      type: "array",
      title: "Construction drawing PDFs",
      items: { type: "string", format: "file" },
      "x-openpond-upload": {
        accept: [".pdf"],
        multiple: true,
        targetPath: "volumes/drawing-plans/drawings",
      },
    },
    drawingFile: {
      type: "string",
      title: "Construction drawing PDF",
      format: "file",
      "x-openpond-upload": {
        accept: [".pdf"],
        targetPath: "volumes/drawing-plans/drawings",
      },
    },
    historyFiles: {
      type: "array",
      title: "Historical estimate files",
      items: { type: "string", format: "file" },
      "x-openpond-upload": {
        accept: [".xlsx", ".xls", ".csv"],
        multiple: true,
        targetPath: "volumes/water-history/history",
      },
    },
    proposalFile: {
      type: "string",
      title: "Proposal file",
      format: "file",
      "x-openpond-upload": {
        accept: [".pdf", ".txt", ".md", ".csv", ".xlsx", ".xls"],
        targetPath: "volumes/water-history/proposals",
      },
    },
    proposalUrl: { type: "string", title: "Proposal URL" },
    query: { type: "string", title: "Estimate search query" },
    lookupName: { type: "string", title: "Saved task-plan lookup name" },
    operation: {
      type: "string",
      title: "Task-plan revision operation",
      enum: [
        "approve",
        "reject",
        "export",
        "open-review",
        "rename-run",
        "edit-task",
        "remove-task",
        "combine-tasks",
        "split-task",
        "add-task",
      ],
    },
    taskId: { type: "string", title: "Task id" },
    taskIds: {
      type: "array",
      title: "Task ids",
      items: { type: "string" },
    },
    versionLabel: { type: "string", title: "Version label" },
    revisionNote: { type: "string", title: "Revision note" },
    edits: {
      type: "array",
      title: "Revision edits",
      items: { type: "object" },
    },
    customerName: { type: "string", title: "Project or customer name" },
    pageSelection: {
      type: "string",
      title: "Page selection",
      description: "Optional pages to render, such as 1-3,7,10. Leave blank to render the first maxPages pages.",
    },
    maxPages: {
      type: "integer",
      title: "Max pages",
      default: 12,
      minimum: 1,
      maximum: 500,
    },
    renderAllPages: {
      type: "boolean",
      title: "Render all pages",
      default: false,
    },
    renderDpi: {
      type: "integer",
      title: "Render DPI",
      default: 200,
      minimum: 72,
      maximum: 300,
    },
    drawingDirectory: { type: "string", title: "Drawing directory" },
    taskPageSelection: {
      type: "string",
      title: "Task page selection",
      description: "Optional pages to send to vision, such as 7,9-10,31,33. Leave blank to use taskMaxPages unless taskAllPages is enabled.",
    },
    taskSheetNumbers: {
      type: "string",
      title: "Task sheet numbers",
      description: "Optional comma-separated sheet numbers to send to vision, such as C 110.00,D 110.00,EI 100.00.",
    },
    taskMaxPages: {
      type: "integer",
      title: "Max task pages",
      default: 16,
      minimum: 1,
      maximum: 500,
    },
    taskAllPages: {
      type: "boolean",
      title: "Extract tasks from all indexed pages",
      default: false,
    },
    openaiModel: {
      type: "string",
      title: "OpenAI model",
      default: "gpt-4.1",
    },
    visionDetail: {
      type: "string",
      title: "Vision detail",
      default: "high",
      enum: ["low", "high", "auto", "original"],
    },
  },
} satisfies JsonSchema;

export const waterEstimatorInputSchemas = {
  DrawingTaskPlanInput: { $ref: "#/inputSchema" },
  EstimateReviewInput: { $ref: "#/inputSchema" },
  TaskPlanHistoryInput: { $ref: "#/inputSchema" },
  TaskPlanRevisionInput: { $ref: "#/inputSchema" },
} satisfies Record<string, JsonSchema>;
