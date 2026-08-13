import type {
  DefineProjectActionOptions,
  ProjectActionDefinition,
} from "./types.js";
import { z } from "zod";

const ACTION_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

export function defineAction<TInput, TOutput>(
  id: string,
  options: DefineProjectActionOptions<TInput, TOutput>,
): ProjectActionDefinition<TInput, TOutput> {
  const normalizedId = id.trim();
  if (!ACTION_ID.test(normalizedId) || normalizedId.length > 191) {
    throw new Error(
      `Invalid Project Action id ${JSON.stringify(id)}. Use a lowercase stable id such as analytics.get_summary.`,
    );
  }
  const description = options.description.trim();
  if (!description) throw new Error(`Project Action ${normalizedId} requires a description.`);
  if (description.length > 1_000) throw new Error(`Project Action ${normalizedId} description must be at most 1000 characters.`);
  if (!(options.input instanceof z.ZodType)) {
    throw new Error(`Project Action ${normalizedId} input must be a Zod schema.`);
  }
  if (!(options.output instanceof z.ZodType)) {
    throw new Error(`Project Action ${normalizedId} output must be a Zod schema.`);
  }
  if (typeof options.run !== "function") {
    throw new Error(`Project Action ${normalizedId} requires a run function.`);
  }
  const behavior = options.behavior ?? "read";
  if (behavior !== "read" && behavior !== "write") {
    throw new Error(`Project Action ${normalizedId} behavior must be read or write.`);
  }
  const approval = options.approval ?? {
    mode: behavior === "write" ? "writes" : "never",
  };
  if (!["never", "always", "writes", "sensitive"].includes(approval.mode)) {
    throw new Error(`Project Action ${normalizedId} has an invalid approval mode.`);
  }
  const label = options.label?.trim() || titleFromId(normalizedId);
  if (label.length > 160) throw new Error(`Project Action ${normalizedId} label must be at most 160 characters.`);
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 3_600_000) {
    throw new Error(`Project Action ${normalizedId} timeoutMs must be between 1000 and 3600000.`);
  }
  const concurrency = options.concurrency ?? null;
  if (concurrency !== null && (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 1_000)) {
    throw new Error(`Project Action ${normalizedId} concurrency must be null or an integer from 1 to 1000.`);
  }
  const setup = [...(options.setup ?? [])];
  const setupKeys = new Set<string>();
  for (const requirement of setup) {
    if (!["connection", "env", "package", "native_tool"].includes(requirement.kind)) {
      throw new Error(`Project Action ${normalizedId} has an invalid setup requirement kind.`);
    }
    if (!requirement.name?.trim()) {
      throw new Error(`Project Action ${normalizedId} has a setup requirement without a name.`);
    }
    const key = `${requirement.kind}:${requirement.name}`;
    if (setupKeys.has(key)) throw new Error(`Project Action ${normalizedId} repeats setup requirement ${key}.`);
    setupKeys.add(key);
  }
  return Object.freeze({
    kind: "openpond-project-action" as const,
    id: normalizedId,
    label,
    description,
    behavior,
    inputSchema: options.input,
    outputSchema: options.output,
    approval,
    setup: Object.freeze(setup),
    invokesModel: options.invokesModel ?? false,
    timeoutMs,
    concurrency,
    run: options.run,
  });
}

export function isProjectActionDefinition(value: unknown): value is ProjectActionDefinition {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { kind?: unknown }).kind === "openpond-project-action" &&
      typeof (value as { id?: unknown }).id === "string" &&
      typeof (value as { run?: unknown }).run === "function",
  );
}

function titleFromId(id: string): string {
  return id
    .split(/[._-]/g)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}
