import { integration } from "openpond-agent-sdk";

export const waterEstimatorIntegrations = [
  integration.opchat({
    models: ["openpond-chat"],
    scopes: ["opchat:model:read", "opchat:chat:create"],
  }),
  integration.microsoftTeams({
    required: false,
    capabilities: ["microsoft_teams.message.ingest"],
  }),
  integration.slack({
    required: false,
    capabilities: ["slack.message.ingest"],
  }),
];
