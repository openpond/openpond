import { integration } from "openpond-agent-sdk";

export const customerReplyIntegrations = [
  integration.openpondChat({ required: true }),
  integration.slack({
    required: false,
    capabilities: ["slack.message.read", "slack.message.send"],
  }),
];
