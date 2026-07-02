import {
  optionString,
  parseJsonOption,
  requiredTeamId,
  resolveSandboxClient,
} from "./common";

function usage(): string {
  return [
    "usage: teams-bot <overview|bind|rebind|diagnostics|diagnostic-run>",
    "  teams-bot overview --team-id <id>",
    "  teams-bot bind --team-id <id> --token <token> [--project-id <id>] [--agent-id <id>] [--microsoft-connection-id <id>]",
    "  teams-bot rebind <bindingId> --team-id <id> [--project-id <id>] [--agent-id <id>] [--microsoft-connection-id <id>]",
    "  teams-bot diagnostics <bindingId> --team-id <id>",
    "  teams-bot diagnostic-run <bindingId> --team-id <id> --prompt <text> [--attachments-json <json-array>] [--action-input-json <json-object>]",
  ].join("\n");
}

function nullableOption(
  options: Record<string, string | boolean>,
  key: string
): string | null | undefined {
  if (!(key in options)) return undefined;
  const value = optionString(options, key);
  if (!value || value === "null" || value === "none") return null;
  return value;
}

function bindingTargetInput(options: Record<string, string | boolean>): {
  teamId: string;
  sandboxId?: string | null;
  projectId?: string | null;
  agentId?: string | null;
  microsoftConnectionId?: string | null;
} {
  const teamId = requiredTeamId(options, "usage: teams-bot rebind <bindingId>");
  const sandboxId = nullableOption(options, "sandboxId");
  const projectId = nullableOption(options, "projectId");
  const agentId = nullableOption(options, "agentId");
  const microsoftConnectionId = nullableOption(options, "microsoftConnectionId");
  return {
    teamId,
    ...(sandboxId !== undefined ? { sandboxId } : {}),
    ...(projectId !== undefined ? { projectId } : {}),
    ...(agentId !== undefined ? { agentId } : {}),
    ...(microsoftConnectionId !== undefined ? { microsoftConnectionId } : {}),
  };
}

function attachmentsInput(
  options: Record<string, string | boolean>
): Array<Record<string, unknown>> | undefined {
  const raw = optionString(options, "attachmentsJson");
  if (!raw) return undefined;
  const parsed = parseJsonOption(raw, "attachments-json");
  if (!Array.isArray(parsed)) {
    throw new Error("attachments-json must be a JSON array");
  }
  for (const attachment of parsed) {
    if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) {
      throw new Error("attachments-json entries must be JSON objects");
    }
  }
  return parsed as Array<Record<string, unknown>>;
}

function actionInput(
  options: Record<string, string | boolean>
): Record<string, unknown> | undefined {
  const raw = optionString(options, "actionInputJson");
  if (!raw) return undefined;
  const parsed = parseJsonOption(raw, "action-input-json");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("action-input-json must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

export async function runTeamsBotCommand(
  options: Record<string, string | boolean>,
  rest: string[]
): Promise<void> {
  const subcommand = rest[0] || "overview";
  const client = await resolveSandboxClient(options);

  if (subcommand === "overview") {
    const teamId = requiredTeamId(options, "usage: teams-bot overview");
    console.log(
      JSON.stringify(await client.getMicrosoftTeamsBotOverview({ teamId }), null, 2)
    );
    return;
  }

  if (subcommand === "bind") {
    const token = optionString(options, "token");
    if (!token) throw new Error(usage());
    const result = await client.bindMicrosoftTeamsBotConversation({
      ...bindingTargetInput(options),
      token,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subcommand === "rebind") {
    const bindingId = rest[1]?.trim();
    if (!bindingId) throw new Error(usage());
    const result = await client.rebindMicrosoftTeamsBotConversation(
      bindingId,
      bindingTargetInput(options)
    );
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subcommand === "diagnostics") {
    const bindingId = rest[1]?.trim();
    const teamId = requiredTeamId(options, "usage: teams-bot diagnostics <bindingId>");
    if (!bindingId) throw new Error(usage());
    console.log(
      JSON.stringify(
        await client.sendMicrosoftTeamsBotDiagnostic({ teamId, bindingId }),
        null,
        2
      )
    );
    return;
  }

  if (subcommand === "diagnostic-run") {
    const bindingId = rest[1]?.trim();
    const teamId = requiredTeamId(
      options,
      "usage: teams-bot diagnostic-run <bindingId>"
    );
    const prompt = optionString(options, "prompt");
    if (!bindingId || !prompt) throw new Error(usage());
    console.log(
      JSON.stringify(
        await client.sendMicrosoftTeamsBotDiagnosticRun({
          teamId,
          bindingId,
          prompt,
          attachments: attachmentsInput(options),
          actionInput: actionInput(options),
        }),
        null,
        2
      )
    );
    return;
  }

  throw new Error(usage());
}
