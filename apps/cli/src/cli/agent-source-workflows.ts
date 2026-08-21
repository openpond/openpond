import type { OpenPondSandboxClient } from "../sandbox/client";
import { requiredTeamId } from "./common";
import {
  buildAgentSourceChecksInput,
  buildAgentSourcePublishInput,
  parsePositiveLimit,
} from "./project-agent-inputs";

export async function runAgentSourceWorkflow(
  client: OpenPondSandboxClient,
  options: Record<string, string | boolean>,
  rest: string[]
): Promise<void> {
  const sourceCommand = rest[1]?.trim();
  const agentId = rest[2]?.trim();
  const usage =
    "usage: agent source <deploy-plan|checks|manifest-snapshots|setup|publish> <agent-id> --team-id <id>";
  const teamId = requiredTeamId(options, usage);
  if (!sourceCommand || !agentId) {
    throw new Error(usage);
  }
  if (sourceCommand === "deploy-plan") {
    const deployPlan = await client.agents.sourceDeployPlan(agentId, {
      teamId,
    });
    console.log(JSON.stringify({ deployPlan }, null, 2));
    return;
  }
  if (sourceCommand === "manifest-snapshots") {
    const manifestSnapshots = await client.agents.manifestSnapshots(agentId, {
      teamId,
      limit: parsePositiveLimit(options.limit),
    });
    console.log(JSON.stringify({ manifestSnapshots }, null, 2));
    return;
  }
  if (sourceCommand === "checks") {
    const result = await client.agents.requestSourceChecks(
      agentId,
      buildAgentSourceChecksInput(teamId, options)
    );
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (sourceCommand === "setup") {
    const provider = typeof options.provider === "string" ? options.provider.trim() : "";
    const allowedActions = typeof options.allowedActions === "string"
      ? options.allowedActions.split(",").map((value) => value.trim()).filter(Boolean)
      : [];
    if (!provider || allowedActions.length === 0) {
      throw new Error(`${usage}; setup requires --provider and --allowed-actions`);
    }
    const result = await client.agents.configureSourceSetup(agentId, {
      teamId,
      integrationBindings: [{
        provider,
        mode: "connected",
        connectionMode: "member_connection",
        grantPolicy: "read_only",
        allowedActions,
        enabled: true,
      }],
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (sourceCommand === "publish") {
    const result = await client.agents.publishSource(
      agentId,
      buildAgentSourcePublishInput(teamId, options)
    );
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  throw new Error(usage);
}
