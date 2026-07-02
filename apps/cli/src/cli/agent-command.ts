import {
  optionString,
  optionalJsonObject,
  parseBooleanOption,
  parseSandboxWorkflowModeOption,
  requiredTeamId,
  resolveSandboxClient,
} from "./common";
import {
  buildAgentSourceConfig,
  buildAgentSourcePolicy,
  buildAgentUpdateInput,
  buildAgentUpsertInput,
  parseAgentTriggerType,
} from "./project-agent-inputs";
import { formatAgentLine } from "./project-agent-formatters";
import { runAgentEditWorkflow, runAgentSourceWorkflow } from "./agent-source-workflows";
import {
  runLocalAgentSdkCommand,
  shouldDelegateLocalAgentSdkCommand,
} from "./agent-sdk-local-command";

export async function runAgentCommand(
  options: Record<string, string | boolean>,
  rest: string[]
): Promise<void> {
  const subcommand = rest[0] || "list";
  if (shouldDelegateLocalAgentSdkCommand(subcommand, options)) {
    await runLocalAgentSdkCommand(options, rest);
    return;
  }
  const client = await resolveSandboxClient(options);

  if (subcommand === "list") {
    const teamId = requiredTeamId(options, "usage: agent list");
    const agents = await client.agents.list({ teamId });
    if (parseBooleanOption(options.json)) {
      console.log(JSON.stringify({ agents }, null, 2));
      return;
    }
    if (agents.length === 0) {
      console.log("no sandbox agents found");
      return;
    }
    for (const agent of agents) {
      console.log(formatAgentLine(agent));
    }
    return;
  }

  if (subcommand === "create" || subcommand === "upsert") {
    const agent = await client.agents.upsert(buildAgentUpsertInput(options));
    console.log(JSON.stringify({ agent }, null, 2));
    return;
  }

  if (subcommand === "get") {
    const agentId = rest[1]?.trim();
    const teamId = requiredTeamId(options, "usage: agent get <agentId>");
    if (!agentId) {
      throw new Error("usage: agent get <agentId> --team-id <id>");
    }
    const agent = await client.agents.get(agentId, { teamId });
    console.log(JSON.stringify({ agent }, null, 2));
    return;
  }

  if (subcommand === "run") {
    const agentId = rest[1]?.trim();
    const teamId = requiredTeamId(options, "usage: agent run <agentId>");
    if (!agentId) {
      throw new Error("usage: agent run <agentId> --team-id <id>");
    }
    const idempotencyKey = optionString(options, "idempotencyKey");
    const conversationId = optionString(options, "conversationId");
    const triggerType = parseAgentTriggerType(options.triggerType);
    const workflowMode = parseSandboxWorkflowModeOption(options.workflowMode);
    const inputObject = optionalJsonObject(options, "input", "input");
    const metadata = optionalJsonObject(options, "metadata", "metadata");
    const agentSourcePolicy = buildAgentSourcePolicy(options);
    const result = await client.agents.run(agentId, {
      teamId,
      ...(conversationId ? { conversationId } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(triggerType ? { triggerType } : {}),
      ...(workflowMode ? { workflowMode } : {}),
      ...(inputObject ? { input: inputObject } : {}),
      ...(metadata ? { metadata } : {}),
      ...(agentSourcePolicy ? { runtimeSourcePolicy: agentSourcePolicy } : {}),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subcommand === "bind-runtime-source" || subcommand === "bind-source") {
    const agentId = rest[1]?.trim();
    const teamId = requiredTeamId(
      options,
      "usage: agent bind-source <agentId>"
    );
    if (!agentId) {
      throw new Error(
        "usage: agent bind-source <agentId> --team-id <id> --source-mode latest_source|published_snapshot|auto"
      );
    }
    const agentSource = buildAgentSourceConfig(options);
    if (!agentSource?.mode) {
      throw new Error(
        "usage: agent bind-source <agentId> --team-id <id> --source-mode latest_source|published_snapshot|auto"
      );
    }
    const agent = await client.agents.update(agentId, {
      teamId,
      runtimeSource: agentSource,
    });
    console.log(
      JSON.stringify({ agent, agentSource: agent.runtimeSource }, null, 2)
    );
    return;
  }

  if (subcommand === "run-test") {
    const agentId = rest[1]?.trim();
    const teamId = requiredTeamId(options, "usage: agent run-test <agentId>");
    if (!agentId) {
      throw new Error("usage: agent run-test <agentId> --team-id <id>");
    }
    const idempotencyKey = optionString(options, "idempotencyKey");
    const conversationId = optionString(options, "conversationId");
    const inputObject = optionalJsonObject(options, "input", "input");
    const metadata = optionalJsonObject(options, "metadata", "metadata");
    const workflowMode = parseSandboxWorkflowModeOption(options.workflowMode);
    const result = await client.agents.run(agentId, {
      teamId,
      ...(conversationId ? { conversationId } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(workflowMode ? { workflowMode } : {}),
      ...(inputObject ? { input: inputObject } : {}),
      metadata: {
        ...(metadata ?? {}),
        source: "agent_run_test",
      },
      runtimeSourcePolicy: buildAgentSourcePolicy(
        options,
        "diagnostic"
      ),
    });
    console.log(
      JSON.stringify(
        {
          resolvedRuntimeSource: result.run.runtimeSource,
          agent: result.agent,
          run: result.run,
          sandbox: result.sandbox ?? null,
        },
        null,
        2
      )
    );
    return;
  }

  if (subcommand === "edit") {
    await runAgentEditWorkflow(client, options, rest);
    return;
  }

  if (subcommand === "source") {
    await runAgentSourceWorkflow(client, options, rest);
    return;
  }

  if (subcommand === "update") {
    const agentId = rest[1]?.trim();
    const teamId = requiredTeamId(options, "usage: agent update <agentId>");
    if (!agentId) {
      throw new Error("usage: agent update <agentId> --team-id <id>");
    }
    const agent = await client.agents.update(
      agentId,
      buildAgentUpdateInput(teamId, options)
    );
    console.log(JSON.stringify({ agent }, null, 2));
    return;
  }

  if (subcommand === "archive") {
    const agentId = rest[1]?.trim();
    const teamId = requiredTeamId(options, "usage: agent archive <agentId>");
    if (!agentId) {
      throw new Error("usage: agent archive <agentId> --team-id <id>");
    }
    const agent = await client.agents.archive(agentId, { teamId });
    console.log(JSON.stringify({ agent }, null, 2));
    return;
  }

  throw new Error(
    "usage: agent <inspect|build|validate|eval|traces|list|create|upsert|get|update|run|run-test|bind-source|source|edit|archive> [--team-id <id>] [--project-id <id>] [--name <name>]"
  );
}
