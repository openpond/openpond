import {
  defineAgentProject,
  defineInstructions,
  defineSkill,
} from "openpond-agent-sdk";

import { waterEstimatorActions } from "./actions";
import microsoftTeams from "./channels/microsoft-teams";
import mcp from "./channels/mcp";
import openpondChat from "./channels/openpond-chat";
import slack from "./channels/slack";
import { waterEstimatorEditable } from "./editable";
import emptyChatEval from "./evals/clarifying-question.eval";
import estimateReviewEval from "./evals/estimate-review.eval";
import taskPlanEval from "./evals/generate-task-plan.eval";
import { waterEstimatorInputSchema, waterEstimatorInputSchemas } from "./input-schema";
import { waterEstimatorIntegrations } from "./integrations";
import dailyEstimateDigest from "./schedules/daily-estimate-digest";
import { waterEstimatorTools } from "./tools/water-estimator-tools";
import { waterEstimatorVolumes } from "./volumes";
import {
  generateEstimateReviewWorkflow,
} from "./workflows/generate-estimate-review";
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

export default defineAgentProject({
  name: "cloud-water-estimator-example",
  version: "0.1.0",
  useCase: "cloud-water-estimator",
  description: "Construction drawing task planning and water-treatment estimate review.",
  manifestMode: "typescript",
  runtime: { base: "node-bun-workspace" },
  resources: { cpu: 2, memoryGb: 4, diskGb: 20 },
  instructions: defineInstructions("./agent/instructions.md"),
  skills: [
    defineSkill({
      name: "water-estimator-process",
      description: "Routing and artifact expectations for drawing, estimate, history, and revision workflows.",
      source: "./agent/skills/water-estimator-process.md",
    }),
  ],
  volumes: waterEstimatorVolumes,
  setup: {
    commands: [
      "mkdir -p artifacts volumes/drawing-plans/drawings volumes/drawing-plans/rendered volumes/drawing-plans/artifacts volumes/water-history/history volumes/water-history/proposals volumes/water-history/artifacts",
    ],
  },
  inputSchema: waterEstimatorInputSchema,
  inputSchemas: waterEstimatorInputSchemas,
  validation: {
    commands: [
      "test -f agent/agent.ts",
      "test -f agent/workflows/chat.ts",
      "command -v pdfinfo",
      "command -v pdftoppm",
    ],
  },
  integrations: waterEstimatorIntegrations,
  defaultAction: "chat",
  actions: waterEstimatorActions,
  tools: waterEstimatorTools,
  workflows: [
    generateTaskPlanWorkflow,
    generateEstimateReviewWorkflow,
    renderDrawingsWorkflow,
    extractSheetIndexWorkflow,
    extractPageTasksWorkflow,
    consolidateTaskPlanWorkflow,
    exportTaskPlanWorkflow,
    taskPlanHistoryWorkflow,
    taskPlanRevisionWorkflow,
  ],
  channels: [openpondChat, microsoftTeams, slack, mcp],
  schedules: [dailyEstimateDigest],
  editable: waterEstimatorEditable,
  evals: [taskPlanEval, estimateReviewEval, emptyChatEval],
});
