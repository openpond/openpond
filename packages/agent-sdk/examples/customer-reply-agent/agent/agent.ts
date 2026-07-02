import {
  defineAgentProject,
} from "openpond-agent-sdk";

import { customerReplyActions } from "./actions";
import openpondChat from "./channels/openpond-chat";
import slack from "./channels/slack";
import { customerReplyEditable } from "./editable";
import replyEval from "./evals/reply.eval";
import instructions from "./instructions";
import { customerReplyIntegrations } from "./integrations";
import replyStyleSkill from "./skills/reply-style";
import { draftReplyWorkflow } from "./workflows/chat";

export default defineAgentProject({
  name: "customer-reply-agent",
  version: "0.1.0",
  useCase: "customer-reply",
  description: "Template agent for drafting concise customer replies.",
  manifestMode: "typescript",
  runtime: { base: "node-bun-workspace" },
  instructions,
  skills: [replyStyleSkill],
  integrations: customerReplyIntegrations,
  defaultAction: "chat",
  actions: customerReplyActions,
  workflows: [draftReplyWorkflow],
  channels: [openpondChat, slack],
  editable: customerReplyEditable,
  evals: [replyEval],
});
