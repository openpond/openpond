import { action } from "openpond-agent-sdk";

import { answerWorkflow, blankChatRouter } from "./workflows/chat";

export const blankActions = [
  action("chat", {
    description: "Shared chat entrypoint for the blank agent.",
    target: { kind: "intent-router", router: blankChatRouter },
    visibility: "default",
    timeoutSeconds: 300,
  }),
  action("answer", {
    description: "Direct answer action for testing action/workflow wiring.",
    target: { kind: "workflow", workflow: answerWorkflow },
    visibility: "end_user",
    timeoutSeconds: 300,
  }),
];
