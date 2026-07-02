import path from "node:path";
import {
  DEFAULT_CHAT_PROVIDER,
  type ChatProvider,
} from "@openpond/contracts";
import {
  normalizeTerminalProvider,
  parseProviderModelSelection,
} from "./formatting.js";

export type TerminalOptions = {
  server: string;
  provider: ChatProvider;
  model: string | null;
  cwd: string;
  project: string | null;
  resume: string | null;
  noServerStart: boolean;
};

export function parseTerminalArgs(
  argv: string[],
  defaultCwd = process.cwd()
): { command: string; options: TerminalOptions } {
  const [command = "chat", ...rest] = argv;
  const options: TerminalOptions = {
    server: "http://127.0.0.1:17874",
    provider: DEFAULT_CHAT_PROVIDER,
    model: null,
    cwd: defaultCwd,
    project: null,
    resume: null,
    noServerStart: false,
  };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (arg === "--server") options.server = rest[++i] ?? options.server;
    else if (arg === "--provider") {
      options.provider = normalizeTerminalProvider(rest[++i] ?? null) ?? options.provider;
    } else if (arg === "--model") {
      const selection = parseProviderModelSelection(rest[++i] ?? null, options.provider);
      if (selection.provider) options.provider = selection.provider;
      options.model = selection.model;
    } else if (arg === "--cwd") {
      options.cwd = path.resolve(rest[++i] ?? options.cwd);
    } else if (arg === "--project") {
      options.project = rest[++i] ?? null;
    } else if (arg === "--resume") {
      options.resume = rest[++i] ?? null;
    } else if (arg === "--no-server-start") {
      options.noServerStart = true;
    }
  }
  return { command, options };
}
