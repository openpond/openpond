export type GoalToolFamily =
  | "files"
  | "shell"
  | "questions"
  | "approvals"
  | "checks"
  | "artifacts"
  | "source"
  | "openpond_agent_sdk";

export type ToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

type GoalToolRegistration = {
  family: GoalToolFamily;
  canonicalName: string;
  aliases: string[];
  schema?: ToolDefinition;
};

const OPENPOND_AGENT_SDK_COMMANDS = [
  "inspect",
  "build",
  "validate",
  "eval",
  "traces",
] as const;

const GOAL_TOOL_REGISTRY: GoalToolRegistration[] = [
  {
    family: "files",
    canonicalName: "files.read",
    aliases: ["files_read", "files.read"],
    schema: tool(
      "files_read",
      "Read a UTF-8 file from the goal workspace.",
      {
        path: stringSchema("Workspace-relative path to read."),
      },
      ["path"]
    ),
  },
  {
    family: "files",
    canonicalName: "files.write",
    aliases: ["files_write", "files.write"],
    schema: tool(
      "files_write",
      "Write a UTF-8 file inside the goal workspace.",
      {
        path: stringSchema("Workspace-relative path to write."),
        content: stringSchema("Complete file content to write."),
      },
      ["path", "content"]
    ),
  },
  {
    family: "files",
    canonicalName: "files.list",
    aliases: ["files_list", "files.list"],
    schema: tool(
      "files_list",
      "List direct children of a workspace directory.",
      {
        path: {
          ...stringSchema("Workspace-relative directory path. Defaults to root."),
          default: ".",
        },
      }
    ),
  },
  {
    family: "shell",
    canonicalName: "shell.run",
    aliases: ["shell", "shell_run", "shell.run"],
    schema: tool(
      "shell_run",
      "Run a shell command inside the goal workspace.",
      {
        command: stringSchema("Command to execute."),
        cwd: {
          ...stringSchema("Workspace-relative directory. Defaults to root."),
          default: ".",
        },
        timeoutSeconds: {
          type: "number",
          minimum: 1,
          maximum: 600,
          description: "Optional command timeout in seconds.",
        },
      },
      ["command"]
    ),
  },
  {
    family: "questions",
    canonicalName: "questions.ask",
    aliases: ["questions", "questions_ask", "questions.ask"],
    schema: tool(
      "questions_ask",
      "Ask a structured user question and pause if required.",
      {
        title: stringSchema("Short question title."),
        reason: stringSchema("Why the answer is needed."),
        required: {
          type: "boolean",
          description: "Whether work must pause until answered.",
          default: true,
        },
        freeformAllowed: {
          type: "boolean",
          description: "Whether the user may type a custom answer.",
          default: true,
        },
        options: {
          type: "array",
          description: "Optional answer choices.",
          items: {
            type: "object",
            properties: {
              id: stringSchema("Stable option id."),
              label: stringSchema("User-visible option label."),
              description: stringSchema("Optional option detail."),
            },
            required: ["id", "label"],
            additionalProperties: false,
          },
        },
      },
      ["title", "reason"]
    ),
  },
  {
    family: "approvals",
    canonicalName: "approvals.request",
    aliases: [
      "approvals",
      "approval_request",
      "approvals_request",
      "approvals.request",
    ],
    schema: tool(
      "approvals_request",
      "Request user approval for publish, integration writes, secret/env changes, budget escalation, or other external side effects.",
      {
        kind: {
          type: "string",
          enum: [
            "create_plan",
            "deploy_publish",
            "integration_write",
            "secret_or_env_change",
            "budget_escalation",
            "external_effect",
          ],
          description: "The type of approval gate needed.",
        },
        title: stringSchema("Short approval title shown to the user."),
        reason: stringSchema("Why approval is required before continuing."),
        payload: {
          type: "object",
          description: "Optional compact approval metadata.",
          additionalProperties: true,
        },
      },
      ["kind", "title", "reason"]
    ),
  },
  {
    family: "checks",
    canonicalName: "checks.run",
    aliases: ["checks", "checks_run", "checks.run"],
    schema: tool(
      "checks_run",
      "Run the goal verification commands.",
      {
        stopOnFailure: {
          type: "boolean",
          description: "Reserved; checks currently stop on first failure.",
          default: true,
        },
      }
    ),
  },
  {
    family: "artifacts",
    canonicalName: "artifacts.create",
    aliases: ["artifacts", "artifacts_create", "artifacts.create"],
    schema: tool(
      "artifacts_create",
      "Create a goal artifact from text content.",
      {
        kind: {
          type: "string",
          enum: ["command_log", "check_log", "patch", "trace", "manifest", "result"],
        },
        name: stringSchema("Artifact file name."),
        content: stringSchema("Artifact text content."),
        mimeType: {
          ...stringSchema("Artifact MIME type."),
          default: "text/plain",
        },
      },
      ["kind", "name", "content"]
    ),
  },
  {
    family: "source",
    canonicalName: "source.finalize",
    aliases: ["source", "source_finalize", "source.finalize"],
    schema: tool(
      "source_finalize",
      "Commit and push checked source changes when policy allows.",
      {
        checksPassed: {
          type: "boolean",
          description: "Whether required checks passed.",
        },
        defaultBranch: {
          ...stringSchema("Default branch to push to, when known."),
          default: "",
        },
      },
      ["checksPassed"]
    ),
  },
  ...OPENPOND_AGENT_SDK_COMMANDS.map((sdkCommand) => ({
    family: "openpond_agent_sdk" as const,
    canonicalName: `openpond_agent.${sdkCommand}`,
    aliases: [`openpond_agent_${sdkCommand}`],
    schema: tool(
      `openpond_agent_${sdkCommand}`,
      `Run project-local openpond-agent ${sdkCommand}.`,
      {
        args: stringArraySchema("Additional CLI args."),
        json: {
          type: "boolean",
          description: "Request JSON output when supported.",
          default:
            sdkCommand === "inspect" ||
            sdkCommand === "eval" ||
            sdkCommand === "traces",
        },
      },
      []
    ),
  })),
  {
    family: "openpond_agent_sdk",
    canonicalName: "openpond_agent.run",
    aliases: ["openpond_agent_run"],
    schema: tool(
      "openpond_agent_run",
      "Run a project-local openpond-agent action.",
      {
        args: stringArraySchema("CLI args, such as --action and --input."),
        json: {
          type: "boolean",
          description: "Request JSON output when supported.",
          default: true,
        },
      },
      []
    ),
  },
  {
    family: "openpond_agent_sdk",
    canonicalName: "openpond_agent.default_checks",
    aliases: [
      "openpond_agent_default_checks",
      "openpond_agent.default_checks",
    ],
    schema: tool(
      "openpond_agent_default_checks",
      "Run inspect, build, validate, and eval through the project-local SDK.",
      {}
    ),
  },
];

const ALIAS_TO_CANONICAL = new Map<string, string>(
  GOAL_TOOL_REGISTRY.flatMap((registration) => [
    [registration.canonicalName, registration.canonicalName] as const,
    ...registration.aliases.map(
      (alias) => [alias, registration.canonicalName] as const
    ),
  ])
);

export function buildGoalLlmToolSchemas(toolNames: string[]): ToolDefinition[] {
  const enabled = new Set(toolNames);
  return GOAL_TOOL_REGISTRY.flatMap((registration) =>
    enabled.has(registration.family) && registration.schema
      ? [registration.schema]
      : []
  );
}

export function normalizeGoalToolName(
  name: string,
  args: Record<string, unknown>
): string {
  const raw = name.trim();
  const canonical = ALIAS_TO_CANONICAL.get(raw);
  if (canonical) return canonical;

  const sdkPrefix = "openpond_agent_";
  if (raw.startsWith(sdkPrefix)) {
    return `openpond_agent.${raw.slice(sdkPrefix.length)}`;
  }
  if (raw === "files") {
    const action = optionalString(args, "action");
    return action ? `files.${action}` : raw;
  }
  if (raw === "openpond_agent_sdk") {
    const command = optionalString(args, "command");
    return command ? `openpond_agent.${command}` : raw;
  }
  return raw;
}

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = []
): ToolDefinition {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      },
    },
  };
}

function stringSchema(description: string): Record<string, unknown> {
  return { type: "string", description };
}

function stringArraySchema(description: string): Record<string, unknown> {
  return {
    type: "array",
    description,
    items: { type: "string" },
    default: [],
  };
}

function optionalString(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
