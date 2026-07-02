import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { ARTIFACT_DIR } from "../core/constants";
import type { CliOptions } from "../core/types";

export async function parseArgs(args: string[]): Promise<CliOptions> {
  const [command = "help", maybeActionName, ...rest] = args;
  let cwd = process.cwd();
  let outDir = ARTIFACT_DIR;
  let json = false;
  let actionName: string | undefined = command === "run" ? maybeActionName : undefined;
  let templateName: string | undefined = command === "init" ? maybeActionName : undefined;
  let force = false;
  let input: Record<string, unknown> | undefined;
  const optionArgs = command === "run" || command === "init" ? rest : args.slice(1);

  for (let index = 0; index < optionArgs.length; index += 1) {
    const arg = optionArgs[index];
    if (arg === "--cwd") {
      const value = optionArgs[index + 1];
      if (!value) throw new Error("--cwd requires a value");
      cwd = path.resolve(value);
      index += 1;
      continue;
    }
    if (arg === "--out-dir") {
      const value = optionArgs[index + 1];
      if (!value) throw new Error("--out-dir requires a value");
      outDir = value;
      index += 1;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--input") {
      input = parseJsonArgument(optionArgs[index + 1], "--input");
      index += 1;
      continue;
    }
    if (arg === "--input-file") {
      const value = optionArgs[index + 1];
      if (!value) throw new Error("--input-file requires a path");
      input = JSON.parse(await readFile(path.resolve(cwd, value), "utf8")) as Record<string, unknown>;
      index += 1;
      continue;
    }
    if (command === "run" && !actionName) {
      actionName = arg;
      continue;
    }
    if (command === "init" && !templateName) {
      templateName = arg;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    command,
    cwd,
    outDir,
    json,
    actionName,
    templateName,
    force,
    input: input ?? (command === "run" ? parseActionInputEnv(process.env) : undefined),
  };
}

function parseJsonArgument(value: string | undefined, label: string): Record<string, unknown> {
  if (!value) throw new Error(`${label} requires a JSON value`);
  return JSON.parse(value) as Record<string, unknown>;
}

function parseActionInputEnv(env: NodeJS.ProcessEnv): Record<string, unknown> | undefined {
  const encoded = env.OPENPOND_ACTION_INPUT_BASE64?.trim();
  if (encoded) {
    return parseJsonArgument(
      Buffer.from(encoded, "base64").toString("utf8"),
      "OPENPOND_ACTION_INPUT_BASE64",
    );
  }
  const raw = env.OPENPOND_ACTION_INPUT?.trim();
  return raw ? parseJsonArgument(raw, "OPENPOND_ACTION_INPUT") : undefined;
}
