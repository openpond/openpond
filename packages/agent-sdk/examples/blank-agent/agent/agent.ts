import {
  defineAgentProject,
  defineInstructions,
  defineSkill,
} from "openpond-agent-sdk";

import { blankActions } from "./actions";
import openpondChat from "./channels/openpond-chat";
import { blankEditable } from "./editable";
import basicEval from "./evals/basic.eval";
import { answerWorkflow } from "./workflows/chat";

export default defineAgentProject({
  name: "blank-agent",
  version: "0.1.0",
  useCase: "blank-agent",
  description: "Minimal raw source-backed agent scaffold.",
  manifestMode: "typescript",
  runtime: { base: "node-bun-workspace" },
  instructions: defineInstructions("./agent/instructions.md"),
  skills: [
    defineSkill({
      name: "basic",
      description: "Basic response style for the blank agent.",
      source: "./agent/skills/basic.md",
    }),
  ],
  defaultAction: "chat",
  actions: blankActions,
  workflows: [answerWorkflow],
  channels: [openpondChat],
  editable: blankEditable,
  evals: [basicEval],
});
