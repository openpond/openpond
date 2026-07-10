import { getInstalledCliVersion } from "./common/version";
import { parseBooleanOption } from "./common/options";
import type { Command } from "./common/types";
import {
  AGENT_OPTION_SCHEMA,
  CHAT_OPTION_SCHEMA,
  PROJECT_OPTION_SCHEMA,
  SANDBOX_OPTION_SCHEMA,
  SANDBOX_TEMPLATE_OPTION_SCHEMA,
} from "./command-option-schemas";

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
  usages?: readonly string[];
  optionSchema: Record<string, CliCommandOptionKind>;
  handler: (context: CliCommandContext) => Promise<void> | void;
};

export const CLI_GLOBAL_OPTION_SCHEMA = {
  account: "string",
  apiBaseUrl: "string",
  apiBaseurl: "string",
  baseUrl: "string",
  baseurl: "string",
  chatApiBaseUrl: "string",
  chatApiBaseurl: "string",
  checkUpdate: "boolean",
  cwd: "string",
  help: "boolean",
  json: "boolean",
  profile: "string",
  sandboxApiUrl: "string",
  sandboxApiurl: "string",
  tui: "boolean",
  version: "boolean",
} as const satisfies Record<string, CliCommandOptionKind>;

export const CLI_SHORT_OPTION_ALIASES: Readonly<Record<string, string>> = {
  C: "cwd",
  f: "force",
  h: "help",
  j: "json",
  v: "version",
  y: "yes",
};

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
    handler: async () => (await import("./help")).printHelp(),
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
    handler: async () => (await import("./core-commands")).runCheckUpdate(),
  },
  {
    name: "login",
    usage: "openpond login [--base-url <url>]",
    optionSchema: CLI_GLOBAL_OPTION_SCHEMA,
    handler: async ({ options }) => (await import("./core-commands")).runLogin(options),
  },
  {
    name: "init",
    usage: "openpond init [--path <dir>]",
    optionSchema: { path: "string" },
    handler: async ({ options }) => (await import("./profile")).runOpenPondInitCommand(options),
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
    handler: async ({ options, rest }) => (await import("./profile")).runOpenPondProfileCommand(options, rest),
  },
  {
    name: "agents",
    usage: "openpond agents [--json]",
    optionSchema: { json: "boolean" },
    handler: async ({ options, rest }) => (await import("./profile")).runOpenPondAgentsCommand(options, rest),
  },
  ...profileSdkAliasDefinitions(),
  {
    name: "extend",
    usage: "openpond extend <instructions>",
    optionSchema: { cwd: "string" },
    handler: async ({ options, rest }) => (await import("./extend")).runOpenPondExtendCommand(options, rest),
  },
  {
    name: "edit",
    usage: "openpond edit <instructions>",
    optionSchema: { cwd: "string" },
    handler: async ({ options, rest }) => (await import("./extend")).runOpenPondEditCommand(options, rest),
  },
  {
    name: "profiles",
    usage: "openpond profiles [args]",
    optionSchema: { json: "boolean" },
    handler: async ({ options, rest }) => (await import("./core-commands")).runProfiles(options, rest),
  },
  {
    name: "account",
    usage: "openpond account",
    optionSchema: { json: "boolean" },
    handler: async ({ options }) => (await import("./core-commands")).runAccount(options),
  },
  {
    name: "health",
    usage: "openpond health",
    optionSchema: { json: "boolean" },
    handler: async ({ options }) => (await import("./core-commands")).runHealth(options),
  },
  {
    name: "serve",
    usage: "openpond serve [args]",
    optionSchema: {
      host: "string",
      hostname: "string",
      listen: "string",
      port: "integer",
    },
    handler: async ({ options, rest }) => (await import("./app-layer")).runOpenPondServerCommand("serve", options, rest),
  },
  {
    name: "ui",
    usage: "openpond ui [args]",
    optionSchema: {
      host: "string",
      hostname: "string",
      listen: "string",
      port: "integer",
      webRoot: "string",
    },
    handler: async ({ options, rest }) => (await import("./app-layer")).runOpenPondServerCommand("web", options, rest),
  },
  {
    name: "tui",
    aliases: ["interactive"],
    usage: "openpond tui [--provider <id>] [--model <id>] [--project <id>]",
    optionSchema: {
      cwd: "string",
      model: "string",
      noServerStart: "boolean",
      project: "string",
      provider: "string",
      server: "string",
    },
    handler: async ({ options, rest }) => (await import("./app-layer")).runOpenPondTerminalCommand(options, rest),
  },
  {
    name: "chat",
    usage: "openpond chat (--message-file <path>|--message <text>|--stdin) --non-interactive [--provider <id>] [--model <id>] [--project <id>] [--yes] [--approval-policy <policy>] [--json] [--timeout-sec <n>] [--max-output-bytes <n>] [--sandbox <mode>]",
    optionSchema: CHAT_OPTION_SCHEMA,
    handler: async ({ options, rest }) => (await import("./app-layer")).runOpenPondTerminalCommand(options, rest),
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
    optionSchema: SANDBOX_TEMPLATE_OPTION_SCHEMA,
    handler: async ({ options, rest }) => (await import("./sandbox-template")).runSandboxTemplateCommand(options, rest),
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
    handler: async ({ options, rest }) => (await import("./organizations")).runOrganizationsCommand(options, rest),
  },
  {
    name: "project",
    usage: "openpond project <list|create|upsert|get|update|sync|source-upload|archive> [args]",
    optionSchema: PROJECT_OPTION_SCHEMA,
    handler: async ({ options, rest }) => (await import("./project-agent")).runProjectCommand(options, rest),
  },
  {
    name: "agent",
    usage: "openpond agent <inspect|build|validate|eval|traces|list|create|upsert|get|update|run|run-test|bind-source|source|edit|archive> [args]",
    usages: [
      "openpond agent run <action> [--cwd <project>] [--input <json>]",
      "openpond agent run <agentId> --team-id <id> [--conversation-id <id>] [--target-project-id <projectId>] [--input <json>]",
      "openpond agent source check-status <workItemId> --team-id <id> [--limit <n>]",
      "openpond agent edit open <agentId> --team-id <id> --project-id <id> [--message <text>]",
      "openpond agent edit checkpoint-result|commit-result|pr-result <workItemId> --team-id <id> --ref <artifact-ref>",
    ],
    optionSchema: AGENT_OPTION_SCHEMA,
    handler: async ({ options, rest }) => (await import("./project-agent")).runAgentCommand(options, rest),
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
    handler: async ({ options, rest }) => (await import("../goal/cli")).runGoalCommand(options, rest),
  },
  {
    name: "harness",
    usage: "openpond harness desktop <run|attach> <scenario...> [--isolated|--attach|--packaged|--none] [--app <path>] [--artifacts-dir <path>] [--json <path>]",
    optionSchema: {
      artifactsDir: "string",
      attach: "boolean",
      cwd: "string",
      devtoolsPort: "integer",
      grep: "string",
      isolated: "boolean",
      json: "string",
      jsonPath: "string",
      keepHome: "boolean",
      none: "boolean",
      server: "string",
      timeoutMs: "integer",
      token: "string",
      tokenFile: "string",
    },
    handler: async ({ options, rest }) => (await import("./harness")).runHarnessCommand(options, rest),
  },
  {
    name: "sandbox",
    usage: "openpond sandbox <command> [args]",
    optionSchema: SANDBOX_OPTION_SCHEMA,
    handler: async ({ options, rest }) => (await import("./sandbox-command")).runSandboxCommand(options, rest),
  },
  {
    name: "opchat",
    usage: "openpond opchat <command> [args]",
    optionSchema: {
      json: "boolean",
      stream: "boolean",
    },
    handler: async ({ options, rest }) => (await import("./opchat")).runOpChatCommand(options, rest),
  },
  {
    name: "teams-bot",
    usage: "openpond teams-bot <command> [args]",
    optionSchema: {
      json: "boolean",
      teamId: "string",
    },
    handler: async ({ options, rest }) => (await import("./teams-bot")).runTeamsBotCommand(options, rest),
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
    handler: async ({ rest }) => (await import("./core-commands")).runOpentool(rest),
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

export function getCliOptionKind(command: Command, key: string): CliCommandOptionKind | undefined {
  const definition = command ? getCliCommandDefinition(command) : null;
  return definition?.optionSchema[key] ?? CLI_GLOBAL_OPTION_SCHEMA[key as keyof typeof CLI_GLOBAL_OPTION_SCHEMA];
}

export function getAnyCliOptionKind(key: string): CliCommandOptionKind | undefined {
  const globalKind = CLI_GLOBAL_OPTION_SCHEMA[key as keyof typeof CLI_GLOBAL_OPTION_SCHEMA];
  if (globalKind) return globalKind;
  for (const definition of CLI_COMMAND_REGISTRY) {
    const kind = definition.optionSchema[key];
    if (kind) return kind;
  }
  return undefined;
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
  const lines = [
    `Usage:`,
    `  ${definition.usage}`,
    ...(definition.usages ?? []).map((usage) => `  ${usage}`),
  ];
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
  const aliases = ["inspect", "build", "validate", "eval", "run"] as const;
  return aliases.map((name) => ({
    name,
    usage: `openpond ${name} [args]`,
    optionSchema: PROFILE_SDK_OPTION_SCHEMA,
    handler: async ({ options, rest }) => (await import("./profile")).runOpenPondProfileSdkAlias(name, options, rest),
  }));
}

async function runToolCommand({ options, rest }: CliCommandContext): Promise<void> {
  const { runToolList, runToolRun } = await import("./core-commands");
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
  const { runBacktestRun } = await import("./core-commands");
  const { runBacktestEvents, runBacktestGet } = await import("./apps");
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
  const { runDeployWatch } = await import("./core-commands");
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
  const { runTemplateBranches, runTemplateStatus, runTemplateUpdate } = await import("./core-commands");
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
  const { runRepoCreate, runRepoPush } = await import("./core-commands");
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
  const {
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
  } = await import("./apps");
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
