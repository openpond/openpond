import type { OpenPondSandboxClient } from "../sandbox/client";
import { requiredTeamId } from "./common";
import {
  buildAgentEditOpenInput,
  buildAgentSourceChecksInput,
  buildAgentSourcePublishInput,
  buildCodingWorkItemBackgroundInput,
  buildCodingWorkItemChatInput,
  buildCodingWorkItemPromotionInput,
  parsePositiveLimit,
} from "./project-agent-inputs";
import {
  compactArtifact,
  compactBackgroundResult,
  compactWorkItemActivity,
  compactWorkItemStatusResult,
} from "./project-agent-formatters";

export async function runAgentEditWorkflow(
  client: OpenPondSandboxClient,
  options: Record<string, string | boolean>,
  rest: string[]
): Promise<void> {
  const editCommand = rest[1]?.trim();
  const targetId = rest[2]?.trim();
  const usage =
    "usage: agent edit <open|chat|activity|background|request-checks|check-status|checkpoint-result|commit-result|pr-result> <id> --team-id <id>";
  const teamId = requiredTeamId(options, usage);
  if (!editCommand || !targetId) {
    throw new Error(usage);
  }
  if (editCommand === "open") {
    const result = await client.agents.openEditWorkItem(
      targetId,
      buildAgentEditOpenInput(targetId, teamId, options)
    );
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (editCommand === "chat") {
    const result = await client.workItems.chat(
      targetId,
      buildCodingWorkItemChatInput(teamId, options)
    );
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (editCommand === "activity") {
    const activity = await client.workItems.activity(targetId, {
      teamId,
      limit: parsePositiveLimit(options.limit),
    });
    console.log(
      JSON.stringify(
        { activity: activity.map((item) => compactWorkItemActivity(item)) },
        null,
        2
      )
    );
    return;
  }
  if (editCommand === "background") {
    const result = await client.workItems.handleBackground(
      targetId,
      buildCodingWorkItemBackgroundInput(teamId, options)
    );
    console.log(JSON.stringify(compactBackgroundResult(result), null, 2));
    return;
  }
  if (editCommand === "request-checks") {
    const result = await client.agents.requestSourceChecks(
      targetId,
      buildAgentSourceChecksInput(teamId, options)
    );
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (editCommand === "check-status") {
    const status = await client.workItems.status(targetId, {
      teamId,
      limit: parsePositiveLimit(options.limit),
      includeArchived: true,
    });
    console.log(JSON.stringify(compactWorkItemStatusResult(status), null, 2));
    return;
  }
  if (
    editCommand === "checkpoint-result" ||
    editCommand === "commit-result" ||
    editCommand === "pr-result"
  ) {
    const input = buildCodingWorkItemPromotionInput(teamId, options);
    const artifact =
      editCommand === "checkpoint-result"
        ? await client.workItems.promoteCheckpoint(targetId, input)
        : editCommand === "commit-result"
          ? await client.workItems.promoteCommit(targetId, input)
          : await client.workItems.promotePullRequest(targetId, input);
    console.log(JSON.stringify({ artifact: compactArtifact(artifact) }, null, 2));
    return;
  }
  throw new Error(usage);
}

export async function runAgentSourceWorkflow(
  client: OpenPondSandboxClient,
  options: Record<string, string | boolean>,
  rest: string[]
): Promise<void> {
  const sourceCommand = rest[1]?.trim();
  const agentId = rest[2]?.trim();
  const usage =
    "usage: agent source <deploy-plan|checks|check-status|manifest-snapshots|publish> <id> --team-id <id>";
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
  if (sourceCommand === "check-status") {
    const status = await client.workItems.status(agentId, {
      teamId,
      limit: parsePositiveLimit(options.limit),
      includeArchived: true,
    });
    console.log(JSON.stringify(compactWorkItemStatusResult(status), null, 2));
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
