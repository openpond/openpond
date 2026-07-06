import {
  runAppsAgentCreate,
  runAppsAssistant,
  runAppsCodeVisibility,
  runAppsDeploy,
  runAppsEnvGet,
  runAppsEnvSet,
  runAppsList,
  runAppsPerformance,
  runAppsPositionsTx,
  runAppsStoreEvents,
  runAppsSummary,
  runAppsTools,
  runAppsToolsExecute,
  runAppsTradeFacts,
  runBacktestEvents,
  runBacktestGet,
} from "./apps";
import { getInstalledCliVersion, parseBooleanOption, type Command } from "./common";
import {
  runAccount,
  runBacktestRun,
  runCheckUpdate,
  runDeployWatch,
  runHealth,
  runLogin,
  runOpentool,
  runProfiles,
  runRepoCreate,
  runRepoPush,
  runTemplateBranches,
  runTemplateStatus,
  runTemplateUpdate,
  runToolList,
  runToolRun,
} from "./core-commands";
import { printHelp } from "./help";
import { runOpenPondServerCommand, runOpenPondTerminalCommand } from "./app-layer";
import { runOpenPondEditCommand, runOpenPondExtendCommand } from "./extend";
import { runGoalCommand } from "../goal/cli";
import { runOpChatCommand } from "./opchat";
import { runOrganizationsCommand } from "./organizations";
import {
  runOpenPondAgentsCommand,
  runOpenPondInitCommand,
  runOpenPondProfileCommand,
  runOpenPondProfileSdkAlias,
} from "./profile";
import { runAgentCommand, runProjectCommand } from "./project-agent";
import { runSandboxCommand } from "./sandbox-command";
import { runSandboxTemplateCommand } from "./sandbox-template";
import { runTeamsBotCommand } from "./teams-bot";

export type CliCommandOptionKind =
  | "boolean"
  | "csv"
  | "integer"
  | "json"
  | "number"
  | "string";

export type CliCommandContext = {
  command: Command;
  options: Record<string, string | boolean>;
  rest: string[];
};

export type CliCommandDefinition = {
  name: Command;
  aliases?: Command[];
  usage: string;
  optionSchema: Record<string, CliCommandOptionKind>;
  handler: (context: CliCommandContext) => Promise<void> | void;
};

const GLOBAL_OPTION_SCHEMA = {
  account: "string",
  apiBaseUrl: "string",
  baseUrl: "string",
  chatApiBaseUrl: "string",
  cwd: "string",
  help: "boolean",
  json: "boolean",
  profile: "string",
  version: "boolean",
} as const satisfies Record<string, CliCommandOptionKind>;

const TEAM_OPTION_SCHEMA = {
  teamId: "string",
} as const satisfies Record<string, CliCommandOptionKind>;

const PROFILE_SDK_OPTION_SCHEMA = {
  cwd: "string",
  input: "json",
  inputFile: "string",
  json: "boolean",
  path: "string",
} as const satisfies Record<string, CliCommandOptionKind>;

export const CLI_COMMAND_REGISTRY: readonly CliCommandDefinition[] = [
  {
    name: "help",
    usage: "openpond help",
    optionSchema: {},
    handler: () => printHelp(),
  },
  {
    name: "version",
    usage: "openpond version",
    optionSchema: {},
    handler: () => console.log(getInstalledCliVersion()),
  },
  {
    name: "check-update",
    usage: "openpond check-update",
    optionSchema: {},
    handler: () => runCheckUpdate(),
  },
  {
    name: "login",
    usage: "openpond login [--base-url <url>]",
    optionSchema: GLOBAL_OPTION_SCHEMA,
    handler: ({ options }) => runLogin(options),
  },
  {
    name: "init",
    usage: "openpond init [--path <dir>]",
    optionSchema: { path: "string" },
    handler: ({ options }) => runOpenPondInitCommand(options),
  },
  {
    name: "profile",
    usage: "openpond profile <current|init|load|check|push|commit|diff|catalog>",
    optionSchema: {
      checkKind: "string",
      conversationId: "string",
      ensureHosted: "boolean",
      expectedManifestHash: "string",
      force: "boolean",
      hostedCheckKind: "string",
      hostedRunAgentId: "string",
      hostedRunConversationId: "string",
      hostedRunIdempotencyKey: "string",
      hostedRunInput: "json",
      hostedRunRetry: "boolean",
      hostedRunTargetProjectId: "string",
      hostedSourceDispatch: "string",
      hostedSourceAgentId: "string",
      hostedSourceChecks: "boolean",
      hostedSourceProjectId: "string",
      json: "boolean",
      kind: "string",
      path: "string",
      publishHostedSource: "boolean",
      teamId: "string",
      workItemId: "string",
    },
    handler: ({ options, rest }) => runOpenPondProfileCommand(options, rest),
  },
  {
    name: "agents",
    usage: "openpond agents [--json]",
    optionSchema: { json: "boolean" },
    handler: ({ options, rest }) => runOpenPondAgentsCommand(options, rest),
  },
  ...profileSdkAliasDefinitions(),
  {
    name: "extend",
    usage: "openpond extend <instructions>",
    optionSchema: { cwd: "string" },
    handler: ({ options, rest }) => runOpenPondExtendCommand(options, rest),
  },
  {
    name: "edit",
    usage: "openpond edit <instructions>",
    optionSchema: { cwd: "string" },
    handler: ({ options, rest }) => runOpenPondEditCommand(options, rest),
  },
  {
    name: "profiles",
    usage: "openpond profiles [args]",
    optionSchema: { json: "boolean" },
    handler: ({ options, rest }) => runProfiles(options, rest),
  },
  {
    name: "account",
    usage: "openpond account",
    optionSchema: { json: "boolean" },
    handler: ({ options }) => runAccount(options),
  },
  {
    name: "health",
    usage: "openpond health",
    optionSchema: { json: "boolean" },
    handler: ({ options }) => runHealth(options),
  },
  {
    name: "serve",
    usage: "openpond serve [args]",
    optionSchema: { port: "integer" },
    handler: ({ options, rest }) => runOpenPondServerCommand("serve", options, rest),
  },
  {
    name: "ui",
    usage: "openpond ui [args]",
    optionSchema: { port: "integer" },
    handler: ({ options, rest }) => runOpenPondServerCommand("web", options, rest),
  },
  {
    name: "tui",
    aliases: ["interactive"],
    usage: "openpond tui [--provider <id>] [--model <id>] [--project <id>]",
    optionSchema: {
      cwd: "string",
      model: "string",
      project: "string",
      provider: "string",
      server: "string",
    },
    handler: ({ options, rest }) => runOpenPondTerminalCommand(options, rest),
  },
  {
    name: "chat",
    usage: "openpond chat [--provider <id>] [--model <id>] [--project <id>] (--message <text>|--message-file <path>|--stdin) --non-interactive [--yes] [--approval-policy <policy>] [--json] [--timeout-sec <n>] [--max-output-bytes <n>] [--sandbox <mode>]",
    optionSchema: {
      approvalPolicy: "string",
      cwd: "string",
      json: "boolean",
      maxOutputBytes: "integer",
      message: "string",
      messageFile: "string",
      model: "string",
      nonInteractive: "boolean",
      project: "string",
      provider: "string",
      sandbox: "string",
      server: "string",
      stdin: "boolean",
      timeoutSec: "integer",
      yes: "boolean",
    },
    handler: ({ options, rest }) => runOpenPondTerminalCommand(options, rest),
  },
  {
    name: "tool",
    usage: "openpond tool <list|run> <handle>/<repo> [args]",
    optionSchema: { body: "json", json: "boolean" },
    handler: runToolCommand,
  },
  {
    name: "backtest",
    usage: "openpond backtest <run|events|get> <handle>/<repo> [args]",
    optionSchema: {
      body: "json",
      branch: "string",
      deploymentId: "string",
      limit: "integer",
      runId: "string",
    },
    handler: runBacktestCommand,
  },
  {
    name: "deploy",
    usage: "openpond deploy watch <handle>/<repo> [--branch <branch>]",
    optionSchema: { branch: "string" },
    handler: runDeployCommand,
  },
  {
    name: "template",
    usage: "openpond template <status|branches|update> <handle>/<repo> [--env preview|production]",
    optionSchema: { env: "string" },
    handler: runTemplateCommand,
  },
  {
    name: "sandbox-template",
    usage: "openpond sandbox-template <command> [args]",
    optionSchema: {
      file: "string",
      json: "boolean",
      teamId: "string",
      workflowMode: "string",
    },
    handler: ({ options, rest }) => runSandboxTemplateCommand(options, rest),
  },
  {
    name: "repo",
    usage: "openpond repo <create|push> [--name <name>] [--path <dir>] [--branch <branch>]",
    optionSchema: {
      branch: "string",
      name: "string",
      path: "string",
    },
    handler: runRepoCommand,
  },
  {
    name: "organizations",
    aliases: ["organization"],
    usage: "openpond organizations <login|list|use|logout|whoami> [args]",
    optionSchema: {
      callbackPort: "integer",
      json: "boolean",
      open: "boolean",
      timeoutSeconds: "integer",
    },
    handler: ({ options, rest }) => runOrganizationsCommand(options, rest),
  },
  {
    name: "project",
    usage: "openpond project <list|create|upsert|get|update|sync|source-upload|archive> [args]",
    optionSchema: {
      ...TEAM_OPTION_SCHEMA,
      json: "boolean",
      path: "string",
      projectId: "string",
      sourceCheckDispatch: "string",
    },
    handler: ({ options, rest }) => runProjectCommand(options, rest),
  },
  {
    name: "agent",
    usage: "openpond agent <inspect|build|validate|eval|traces|list|create|upsert|get|update|run|run-test|bind-source|source|edit|archive> [args]",
    optionSchema: {
      ...TEAM_OPTION_SCHEMA,
      ...PROFILE_SDK_OPTION_SCHEMA,
      agentId: "string",
      baseSha: "string",
      checkKind: "string",
      conversationId: "string",
      dispatch: "string",
      metadata: "json",
      projectId: "string",
      sourceCheckDispatch: "string",
      sourceRef: "string",
      targetProjectId: "string",
    },
    handler: ({ options, rest }) => runAgentCommand(options, rest),
  },
  {
    name: "goal",
    usage: "openpond goal <command> [args]",
    optionSchema: {
      agentId: "string",
      cwd: "string",
      goalStorage: "string",
      json: "boolean",
      goalId: "string",
    },
    handler: ({ options, rest }) => runGoalCommand(options, rest),
  },
  {
    name: "sandbox",
    usage: "openpond sandbox <command> [args]",
    optionSchema: {
      ...TEAM_OPTION_SCHEMA,
      json: "boolean",
      projectId: "string",
      sandboxApiUrl: "string",
    },
    handler: ({ options, rest }) => runSandboxCommand(options, rest),
  },
  {
    name: "opchat",
    usage: "openpond opchat <command> [args]",
    optionSchema: {
      json: "boolean",
      stream: "boolean",
    },
    handler: ({ options, rest }) => runOpChatCommand(options, rest),
  },
  {
    name: "teams-bot",
    usage: "openpond teams-bot <command> [args]",
    optionSchema: {
      json: "boolean",
      teamId: "string",
    },
    handler: ({ options, rest }) => runTeamsBotCommand(options, rest),
  },
  {
    name: "apps",
    usage: "openpond apps <list|code-visibility|tools|deploy|env get|env set|performance|summary|assistant|store events|trade-facts|agent create|positions tx> [args]",
    optionSchema: {
      appId: "string",
      body: "json",
      env: "json",
      json: "boolean",
      limit: "integer",
      refresh: "boolean",
      teamId: "string",
      watch: "boolean",
    },
    handler: runAppsCommand,
  },
  {
    name: "opentool",
    usage: "openpond opentool <init|validate|build> [args]",
    optionSchema: {},
    handler: ({ rest }) => runOpentool(rest),
  },
] as const;

const CLI_COMMAND_BY_NAME = new Map<Command, CliCommandDefinition>();
for (const definition of CLI_COMMAND_REGISTRY) {
  CLI_COMMAND_BY_NAME.set(definition.name, definition);
  for (const alias of definition.aliases ?? []) {
    CLI_COMMAND_BY_NAME.set(alias, definition);
  }
}

export function listCliCommandDefinitions(): readonly CliCommandDefinition[] {
  return CLI_COMMAND_REGISTRY;
}

export function getCliCommandDefinition(command: Command): CliCommandDefinition | null {
  return CLI_COMMAND_BY_NAME.get(command) ?? null;
}

export async function runCliCommand(context: CliCommandContext): Promise<boolean> {
  const definition = getCliCommandDefinition(context.command);
  if (!definition) return false;
  if (parseBooleanOption(context.options.help)) {
    printCliCommandUsage(definition);
    return true;
  }
  await definition.handler(context);
  return true;
}

export function formatCliCommandUsage(definition: CliCommandDefinition): string {
  const lines = [`Usage:`, `  ${definition.usage}`];
  if (definition.aliases?.length) {
    lines.push("", `Aliases:`, `  ${definition.aliases.join(", ")}`);
  }
  const options = Object.entries(definition.optionSchema).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  if (options.length > 0) {
    lines.push("", "Options:");
    for (const [name, kind] of options) {
      const optionName = cliOptionName(name);
      lines.push(kind === "boolean" ? `  --${optionName}` : `  --${optionName} <${kind}>`);
    }
  }
  return lines.join("\n");
}

function printCliCommandUsage(definition: CliCommandDefinition): void {
  console.log(formatCliCommandUsage(definition));
}

function cliOptionName(name: string): string {
  return name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

function profileSdkAliasDefinitions(): CliCommandDefinition[] {
  const aliases: Command[] = ["inspect", "build", "validate", "eval", "run"];
  return aliases.map((name) => ({
    name,
    usage: `openpond ${name} [args]`,
    optionSchema: PROFILE_SDK_OPTION_SCHEMA,
    handler: ({ command, options, rest }) => runOpenPondProfileSdkAlias(command, options, rest),
  }));
}

async function runToolCommand({ options, rest }: CliCommandContext): Promise<void> {
  const subcommand = rest[0];
  if (subcommand === "list") {
    const target = rest[1];
    if (!target) {
      throw new Error("usage: tool list <handle>/<repo>");
    }
    await runToolList(options, target);
    return;
  }
  if (subcommand === "run") {
    const target = rest[1];
    const toolName = rest[2];
    if (!target || !toolName) {
      throw new Error(
        "usage: tool run <handle>/<repo> <tool> [--body <json>]"
      );
    }
    await runToolRun(options, target, toolName);
    return;
  }
  throw new Error("usage: tool <list|run> <handle>/<repo> [args]");
}

async function runBacktestCommand({ options, rest }: CliCommandContext): Promise<void> {
  const subcommand = rest[0] || "run";
  if (subcommand === "run") {
    const target = rest[1];
    const toolName = rest[2];
    if (!target || !toolName) {
      throw new Error(
        "usage: backtest run <handle>/<repo> <tool> [--body <json>] [--branch <branch>] [--deployment-id <id>]"
      );
    }
    await runBacktestRun(options, target, toolName);
    return;
  }
  if (subcommand === "events") {
    const target = rest[1];
    if (!target) {
      throw new Error(
        "usage: backtest events <handle>/<repo> [--run-id <id>] [--limit <n>]"
      );
    }
    await runBacktestEvents(options, target);
    return;
  }
  if (subcommand === "get") {
    const target = rest[1];
    if (!target) {
      throw new Error("usage: backtest get <handle>/<repo> --run-id <id>");
    }
    await runBacktestGet(options, target);
    return;
  }
  throw new Error("usage: backtest <run|events|get> <handle>/<repo> [args]");
}

async function runDeployCommand({ options, rest }: CliCommandContext): Promise<void> {
  const subcommand = rest[0] || "watch";
  if (subcommand !== "watch") {
    throw new Error(
      "usage: deploy watch <handle>/<repo> [--branch <branch>]"
    );
  }
  const target = rest[1];
  if (!target) {
    throw new Error(
      "usage: deploy watch <handle>/<repo> [--branch <branch>]"
    );
  }
  await runDeployWatch(options, target);
}

async function runTemplateCommand({ options, rest }: CliCommandContext): Promise<void> {
  const subcommand = rest[0] || "status";
  const target = rest[1];
  if (!target) {
    throw new Error(
      "usage: template <status|branches|update> <handle>/<repo> [--env preview|production]"
    );
  }
  if (subcommand === "status") {
    await runTemplateStatus(options, target);
    return;
  }
  if (subcommand === "branches") {
    await runTemplateBranches(options, target);
    return;
  }
  if (subcommand === "update") {
    await runTemplateUpdate(options, target);
    return;
  }
  throw new Error(
    "usage: template <status|branches|update> <handle>/<repo> [--env preview|production]"
  );
}

async function runRepoCommand({ options, rest }: CliCommandContext): Promise<void> {
  const subcommand = rest[0] || "create";
  if (subcommand === "create") {
    await runRepoCreate(options, rest.slice(1));
    return;
  }
  if (subcommand === "push") {
    await runRepoPush(options);
    return;
  }
  throw new Error(
    "usage: repo <create|push> [--name <name>] [--path <dir>] [--branch <branch>]"
  );
}

async function runAppsCommand({ options, rest }: CliCommandContext): Promise<void> {
  const subcommand = rest[0];
  if (subcommand === "list") {
    await runAppsList(options);
    return;
  }
  if (subcommand === "code-visibility") {
    const target = rest[1];
    if (!target) {
      throw new Error(
        "usage: apps code-visibility <handle>/<repo> --visibility public|private"
      );
    }
    await runAppsCodeVisibility(options, target);
    return;
  }
  if (subcommand === "tools") {
    if (rest[1] === "execute") {
      const appId = rest[2];
      const deploymentId = rest[3];
      const toolName = rest[4];
      if (!appId || !deploymentId || !toolName) {
        throw new Error(
          "usage: apps tools execute <appId> <deploymentId> <tool> [--body <json>]"
        );
      }
      await runAppsToolsExecute(options, appId, deploymentId, toolName);
      return;
    }
    await runAppsTools();
    return;
  }
  if (subcommand === "deploy") {
    const target = rest[1];
    if (!target) {
      throw new Error(
        "usage: apps deploy <handle>/<repo> [--env preview|production] [--watch]"
      );
    }
    await runAppsDeploy(options, target);
    return;
  }
  if (subcommand === "env" && rest[1] === "get") {
    const target = rest[2];
    if (!target) {
      throw new Error("usage: apps env get <handle>/<repo>");
    }
    await runAppsEnvGet(options, target);
    return;
  }
  if (subcommand === "env" && rest[1] === "set") {
    const target = rest[2];
    if (!target) {
      throw new Error("usage: apps env set <handle>/<repo> --env <json>");
    }
    await runAppsEnvSet(options, target);
    return;
  }
  if (subcommand === "performance") {
    await runAppsPerformance(options);
    return;
  }
  if (subcommand === "summary") {
    const target = rest[1];
    if (!target) {
      throw new Error("usage: apps summary <handle>/<repo>");
    }
    await runAppsSummary(options, target);
    return;
  }
  if (subcommand === "assistant") {
    const mode = rest[1];
    const target = rest[2];
    if ((mode !== "plan" && mode !== "performance") || !target) {
      throw new Error(
        "usage: apps assistant <plan|performance> <handle>/<repo> --prompt <text>"
      );
    }
    await runAppsAssistant(options, mode, target, rest.slice(3));
    return;
  }
  if (subcommand === "store" && rest[1] === "events") {
    await runAppsStoreEvents(options);
    return;
  }
  if (subcommand === "trade-facts") {
    await runAppsTradeFacts(options);
    return;
  }
  if (subcommand === "agent" && rest[1] === "create") {
    await runAppsAgentCreate(options, rest.slice(2));
    return;
  }
  if (subcommand === "positions" && rest[1] === "tx") {
    await runAppsPositionsTx(options);
    return;
  }
  throw new Error(
    "usage: apps <list|code-visibility|tools|deploy|env get|env set|performance|summary|assistant|store events|trade-facts|agent create|positions tx> [args]"
  );
}
