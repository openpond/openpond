import { integration } from "openpond-agent-sdk";

export const waterEstimatorIntegrations = [
  integration.opchat({
    models: ["openpond-chat"],
    scopes: ["opchat:model:read", "opchat:chat:create"],
  }),
  integration.microsoftTeams({
    required: false,
    capabilities: [
      "microsoft_teams.message.read",
      "microsoft_teams.message.send",
      "microsoft_teams.drive.file.download",
      "microsoft_teams.channel.file.upload",
    ],
  }),
  integration.slack({
    required: false,
    capabilities: [
      "slack.message.read",
      "slack.message.send",
      "slack.file.read",
      "slack.file.write",
    ],
  }),
];
