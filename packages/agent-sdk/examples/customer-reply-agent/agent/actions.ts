import { action } from "openpond-agent-sdk";

import { customerReplyRouter, draftReplyWorkflow } from "./workflows/chat";

export const customerReplyActions = [
  action("chat", {
    description: "Shared conversational entrypoint for reply drafting.",
    target: { kind: "intent-router", router: customerReplyRouter },
    visibility: "default",
    timeoutSeconds: 300,
  }),
  action("draft-customer-reply", {
    description: "Draft a customer-facing reply.",
    target: { kind: "workflow", workflow: draftReplyWorkflow },
    visibility: "end_user",
    timeoutSeconds: 300,
  }),
];
