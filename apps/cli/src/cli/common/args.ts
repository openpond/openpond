import type { Command } from "./types";
import { parseJsonOption } from "./options";

const CLI_OPTION_VALUES = Symbol("openpondCliOptionValues");

export type ParsedCliOptions = Record<string, string | boolean> & {
  [CLI_OPTION_VALUES]?: Record<string, string[]>;
};

type CliOptionValueKind = "boolean" | "string" | "number" | "integer" | "json";

const CLI_SHORT_OPTION_ALIASES: Record<string, string> = {
  C: "cwd",
  f: "force",
  h: "help",
  j: "json",
  v: "version",
  y: "yes",
};

const CLI_TYPED_OPTIONS: Record<string, CliOptionValueKind> = {
  account: "string",
  agentId: "string",
  apiBaseUrl: "string",
  baseUrl: "string",
  baseurl: "string",
  branch: "string",
  callbackPort: "integer",
  chatApiBaseUrl: "string",
  chatApiBaseurl: "string",
  chatApiUrl: "string",
  checkKind: "string",
  checkUpdate: "boolean",
  cols: "integer",
  conversationId: "string",
  cpu: "number",
  cwd: "string",
  diskGb: "number",
  env: "string",
  expectedManifestHash: "string",
  force: "boolean",
  goalStorage: "string",
  help: "boolean",
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
  idleTimeoutSeconds: "integer",
  json: "boolean",
  limit: "integer",
  maxDurationSeconds: "integer",
  maxEntries: "integer",
  maxResults: "integer",
  memoryGb: "number",
  path: "string",
  port: "integer",
  profile: "string",
  projectId: "string",
  publishHostedSource: "boolean",
  rows: "integer",
  sandboxApiUrl: "string",
  sandboxApiurl: "string",
  setupTimeoutSeconds: "integer",
  since: "integer",
  sourceCheckDispatch: "string",
  targetProjectId: "string",
  teamId: "string",
  timeout: "integer",
  timeoutMs: "integer",
  timeoutSeconds: "integer",
  tui: "boolean",
  version: "boolean",
  workItemId: "string",
  yes: "boolean",
};

export function parseArgs(argv: string[]): {
  command: Command;
  options: ParsedCliOptions;
  rest: string[];
} {
  const args = [...argv];
  let command = "" as Command;
  const options: ParsedCliOptions = {};
  const optionValues: Record<string, string[]> = {};
  const rest: string[] = [];

  while (args.length > 0) {
    const next = args.shift()!;
    if (next === "--") {
      rest.push(...args);
      break;
    }
    if (next.startsWith("--")) {
      const separatorIndex = next.indexOf("=");
      const rawKey = separatorIndex >= 0
        ? next.slice(2, separatorIndex)
        : next.slice(2);
      const key = normalizeCliOptionKey(rawKey);
      const value =
        separatorIndex >= 0
          ? next.slice(separatorIndex + 1)
          : readOptionValue(args, key);
      setParsedOption(options, optionValues, key, value);
    } else if (isShortOptionToken(next)) {
      parseShortOptionToken(next, args, options, optionValues);
    } else {
      if (!command) {
        command = next as Command;
      } else {
        rest.push(next);
      }
    }
  }

  Object.defineProperty(options, CLI_OPTION_VALUES, {
    value: optionValues,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return { command, options, rest };
}

function normalizeCliOptionKey(rawKey: string): string {
  return rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function isShortOptionToken(value: string): boolean {
  return /^-[^-].*/.test(value) && !isNegativeNumber(value);
}

function parseShortOptionToken(
  token: string,
  args: string[],
  options: ParsedCliOptions,
  optionValues: Record<string, string[]>
): void {
  const body = token.slice(1);
  if (!body) return;
  const equalsIndex = body.indexOf("=");
  const aliasBody = equalsIndex >= 0 ? body.slice(0, equalsIndex) : body;
  const inlineValue = equalsIndex >= 0 ? body.slice(equalsIndex + 1) : null;
  if (aliasBody.length !== 1) {
    for (const alias of aliasBody) {
      const key = CLI_SHORT_OPTION_ALIASES[alias];
      if (!key) {
        throw new Error(`unknown short option -${alias}`);
      }
      const kind = CLI_TYPED_OPTIONS[key];
      if (kind !== "boolean") {
        throw new Error(`short option -${alias} requires its own value`);
      }
      setParsedOption(options, optionValues, key, "true");
    }
    return;
  }

  const key = CLI_SHORT_OPTION_ALIASES[aliasBody];
  if (!key) {
    throw new Error(`unknown short option -${aliasBody}`);
  }
  const value = inlineValue ?? readOptionValue(args, key);
  setParsedOption(options, optionValues, key, value);
}

function readOptionValue(args: string[], key: string): string {
  const kind = CLI_TYPED_OPTIONS[key];
  if (kind === "boolean") {
    if (args[0] && isBooleanLiteral(args[0])) return args.shift()!;
    return "true";
  }
  if (kind) {
    const next = args.shift();
    if (next === undefined || (isOptionLike(next) && !isNegativeNumber(next))) {
      if (next !== undefined) args.unshift(next);
      throw new Error(`${cliOptionLabel(key)} must be ${optionKindPhrase(kind)}`);
    }
    return next;
  }
  return args[0] && !args[0].startsWith("--") ? args.shift()! : "true";
}

function setParsedOption(
  options: ParsedCliOptions,
  optionValues: Record<string, string[]>,
  key: string,
  value: string
): void {
  validateParsedOptionValue(key, value);
  options[key] = value;
  (optionValues[key] ??= []).push(value);
}

function validateParsedOptionValue(key: string, value: string): void {
  const kind = CLI_TYPED_OPTIONS[key];
  if (!kind) return;
  if (kind === "boolean") {
    if (!isBooleanLiteral(value)) {
      throw new Error(`${cliOptionLabel(key)} must be a boolean`);
    }
    return;
  }
  if (value.trim().length === 0 || value === "true") {
    throw new Error(`${cliOptionLabel(key)} must be ${optionKindPhrase(kind)}`);
  }
  if (kind === "number" || kind === "integer") {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      throw new Error(`${cliOptionLabel(key)} must be ${optionKindPhrase(kind)}`);
    }
    if (kind === "integer" && !Number.isInteger(parsed)) {
      throw new Error(`${cliOptionLabel(key)} must be an integer`);
    }
    return;
  }
  if (kind === "json") {
    parseJsonOption(value, cliOptionLabel(key));
  }
}

function cliOptionLabel(key: string): string {
  return key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

function optionKindLabel(kind: CliOptionValueKind): string {
  if (kind === "json") return "JSON value";
  return kind;
}

function optionKindPhrase(kind: CliOptionValueKind): string {
  const label = optionKindLabel(kind);
  return /^[aeiou]/i.test(label) ? `an ${label}` : `a ${label}`;
}

function isBooleanLiteral(value: string): boolean {
  return /^(true|false|1|0|yes|no)$/i.test(value);
}

function isOptionLike(value: string): boolean {
  return value.startsWith("-") && value !== "-";
}

function isNegativeNumber(value: string): boolean {
  return /^-\d+(?:\.\d+)?$/.test(value);
}

export function optionValues(
  options: Record<string, string | boolean>,
  key: string
): string[] {
  const values = (options as ParsedCliOptions)[CLI_OPTION_VALUES]?.[key];
  if (values) return values.map((value) => value.trim());
  const value = options[key];
  return typeof value === "string" ? [value.trim()] : [];
}
