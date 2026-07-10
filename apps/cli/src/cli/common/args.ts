import type { Command } from "./types";
import { parseJsonOption } from "./options";
import {
  CLI_SHORT_OPTION_ALIASES,
  getAnyCliOptionKind,
  getCliCommandDefinition,
  getCliOptionKind,
  type CliCommandOptionKind,
} from "../command-registry";

const CLI_OPTION_VALUES = Symbol("openpondCliOptionValues");

export type ParsedCliOptions = Record<string, string | boolean> & {
  [CLI_OPTION_VALUES]?: Record<string, string[]>;
};

export class CliUsageError extends Error {
  readonly exitCode = 2;

  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

const CLI_POSITIVE_INTEGER_OPTIONS = new Set(["maxOutputBytes", "timeoutSec"]);

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
          : readOptionValue(args, key, command);
      setParsedOption(options, optionValues, key, value, command);
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
  validateCommandOptions(command, options);
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
        throw new CliUsageError(`unknown short option -${alias}`);
      }
      const kind = getAnyCliOptionKind(key);
      if (kind !== "boolean") {
        throw new CliUsageError(`short option -${alias} requires its own value`);
      }
      setParsedOption(options, optionValues, key, "true");
    }
    return;
  }

  const key = CLI_SHORT_OPTION_ALIASES[aliasBody];
  if (!key) {
    throw new CliUsageError(`unknown short option -${aliasBody}`);
  }
  const value = inlineValue ?? readOptionValue(args, key);
  setParsedOption(options, optionValues, key, value);
}

function readOptionValue(args: string[], key: string, command?: Command): string {
  const kind = typedOptionKind(key, command);
  if (kind === "boolean") {
    if (args[0] && isBooleanLiteral(args[0])) return args.shift()!;
    return "true";
  }
  if (kind) {
    const next = args.shift();
    if (next === undefined || (isOptionLike(next) && !isNegativeNumber(next))) {
      if (next !== undefined) args.unshift(next);
      throw new CliUsageError(`${cliOptionLabel(key)} must be ${optionKindPhrase(kind)}`);
    }
    return next;
  }
  return args[0] && !args[0].startsWith("--") ? args.shift()! : "true";
}

function setParsedOption(
  options: ParsedCliOptions,
  optionValues: Record<string, string[]>,
  key: string,
  value: string,
  command?: Command
): void {
  validateParsedOptionValue(key, value, command);
  options[key] = value;
  (optionValues[key] ??= []).push(value);
}

function validateParsedOptionValue(key: string, value: string, command?: Command): void {
  const kind = typedOptionKind(key, command);
  if (!kind) return;
  if (kind === "boolean") {
    if (!isBooleanLiteral(value)) {
      throw new CliUsageError(`${cliOptionLabel(key)} must be a boolean`);
    }
    return;
  }
  if (value.trim().length === 0 || value === "true") {
    throw new CliUsageError(`${cliOptionLabel(key)} must be ${optionKindPhrase(kind)}`);
  }
  if (kind === "number" || kind === "integer") {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      throw new CliUsageError(`${cliOptionLabel(key)} must be ${optionKindPhrase(kind)}`);
    }
    if (kind === "integer" && !Number.isInteger(parsed)) {
      throw new CliUsageError(`${cliOptionLabel(key)} must be an integer`);
    }
    if (kind === "integer" && CLI_POSITIVE_INTEGER_OPTIONS.has(key) && parsed <= 0) {
      throw new CliUsageError(`${cliOptionLabel(key)} must be a positive integer`);
    }
    return;
  }
  if (kind === "json") {
    try {
      parseJsonOption(value, cliOptionLabel(key));
    } catch (error) {
      throw new CliUsageError(error instanceof Error ? error.message : String(error));
    }
  }
}

function typedOptionKind(key: string, command?: Command): CliCommandOptionKind | undefined {
  return command ? getCliOptionKind(command, key) : getAnyCliOptionKind(key);
}

function cliOptionLabel(key: string): string {
  return key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

function optionKindLabel(kind: CliCommandOptionKind): string {
  if (kind === "json") return "JSON value";
  return kind;
}

function optionKindPhrase(kind: CliCommandOptionKind): string {
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

function validateCommandOptions(command: Command, options: ParsedCliOptions): void {
  const definition = command ? getCliCommandDefinition(command) : null;
  for (const key of Object.keys(options)) {
    if (!getCliOptionKind(command, key)) {
      const label = cliOptionLabel(key);
      const suffix = definition ? ` for ${definition.name}` : "";
      throw new CliUsageError(`unknown option --${label}${suffix}`);
    }
  }
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
