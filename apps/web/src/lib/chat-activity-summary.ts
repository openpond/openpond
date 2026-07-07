import type { ActivityItem } from "./app-models";

export type ActivityGroupSummaryKind =
  | "approval"
  | "command"
  | "control"
  | "edit"
  | "image"
  | "list"
  | "read"
  | "reasoning"
  | "search"
  | "subagent"
  | "web";

export type ActivityGroupSummary = {
  kind: ActivityGroupSummaryKind;
  text: string;
};

type ActivityCounters = {
  approvals: number;
  controlCount: number;
  editCount: number;
  imageCount: number;
  listedFiles: number;
  readFileCount: number;
  readFiles: Set<string>;
  reasoningCount: number;
  runCount: number;
  searchedCode: number;
  subagentStatuses: Map<string, SubagentActivityStatus>;
  testsOrChecks: number;
  webSearches: number;
};

type SubagentActivityStatus = "blocked" | "completed" | "failed" | "running";

type CommandSummary = {
  countedAsRun: boolean;
  editCount?: number;
  listedFiles?: number;
  readFiles?: string[];
  searchedCode?: number;
  testsOrChecks?: number;
};

export function summarizeActivityGroup(activities: ActivityItem[]): ActivityGroupSummary {
  const counters = emptyCounters();
  let fallbackLabel = "";
  const genericLabels: string[] = [];
  const outcomeClauses: string[] = [];
  const receiptClauses: string[] = [];

  for (const activity of activities) {
    if (!fallbackLabel && activity.label) fallbackLabel = activity.label;
    addOutcomeClause(outcomeClauses, activity.label);
    addReceiptClause(receiptClauses, activity);
    if (activity.kind === "command" && activity.content) {
      applyCommandSummary(counters, summarizeCommandActivity(activity.content));
      continue;
    }
    if (!applyLabeledActivity(counters, activity)) addGenericLabel(genericLabels, activity.label);
  }

  const clauses = [...primaryClauses(counters), ...outcomeClauses, ...receiptClauses];
  const runClause = counters.runCount > 0 ? ranClause(counters.runCount) : "";
  const genericSummary = formatGenericLabels(genericLabels);
  const text = formatActivityClauses(clauses, runClause) || genericSummary || fallbackLabel || "Ran command";

  return {
    kind: summaryKind(counters, clauses, runClause),
    text,
  };
}

export function activityGroupSummary(activities: ActivityItem[]): string {
  return summarizeActivityGroup(activities).text;
}

export function summarizeShellCommand(command: string): string | null {
  const tokens = shellWords(command);
  if (tokens.length === 0) return null;
  if (tokens.some(isShellOperator)) return null;
  const executable = tokens[0]!;
  if (executable === "cat") {
    const files = nonFlagArgs(tokens.slice(1));
    return files.length > 0 ? `Read ${formatCommandTargets(files)}` : "Read standard input";
  }
  if (executable === "sed") {
    return summarizeSedCommand(tokens);
  }
  if (executable === "rg") {
    return summarizeRipgrepCommand(tokens);
  }
  return null;
}

function emptyCounters(): ActivityCounters {
  return {
    approvals: 0,
    controlCount: 0,
    editCount: 0,
    imageCount: 0,
    listedFiles: 0,
    readFileCount: 0,
    readFiles: new Set<string>(),
    reasoningCount: 0,
    runCount: 0,
    searchedCode: 0,
    subagentStatuses: new Map(),
    testsOrChecks: 0,
    webSearches: 0,
  };
}

function applyCommandSummary(counters: ActivityCounters, summary: CommandSummary): void {
  counters.editCount += summary.editCount ?? 0;
  counters.listedFiles += summary.listedFiles ?? 0;
  counters.searchedCode += summary.searchedCode ?? 0;
  counters.testsOrChecks += summary.testsOrChecks ?? 0;
  for (const file of summary.readFiles ?? []) counters.readFiles.add(file);
  if (summary.readFiles?.length) counters.readFileCount += summary.readFiles.length;
  if (summary.countedAsRun) counters.runCount += 1;
}

function applyLabeledActivity(counters: ActivityCounters, activity: ActivityItem): boolean {
  const label = activity.label.toLowerCase();
  if (activity.controlKind) {
    counters.controlCount += 1;
    return true;
  }
  if (label === "reasoning") {
    counters.reasoningCount += 1;
    return true;
  }
  if (label.includes("approval")) {
    counters.approvals += 1;
    return true;
  }
  if (label.includes("subagent")) {
    const status = label.includes("failed")
      ? "failed"
      : label.includes("blocked")
        ? "blocked"
        : label.includes("completed")
          ? "completed"
          : "running";
    setSubagentStatus(counters, activity, status);
    return true;
  }
  if (label.includes("image")) {
    counters.imageCount += 1;
    return true;
  }
  if (label.includes("web")) {
    counters.webSearches += 1;
    return true;
  }
  if (/\b(searching|searched)\b/.test(label)) {
    counters.searchedCode += 1;
    return true;
  }
  if (/\b(listing|listed)\b/.test(label)) {
    counters.listedFiles += 1;
    return true;
  }
  if (/\b(reading|read)\b/.test(label)) {
    counters.readFileCount += 1;
    return true;
  }
  if (/\b(editing|edited|writing|wrote|deleting|deleted|moving|moved|uploading|uploaded|creating|created)\b/.test(label)) {
    counters.editCount += 1;
    return true;
  }
  return false;
}

function summarizeCommandActivity(command: string): CommandSummary {
  const tokens = shellWords(command);
  if (tokens.length === 0 || tokens.some(isShellOperator)) return { countedAsRun: true };

  const executable = stripCommandWrapper(tokens);
  if (!executable) return { countedAsRun: true };
  const [name, args] = executable;

  if (name === "apply_patch") return { countedAsRun: false, editCount: 1 };
  if (["rm", "mv", "cp", "mkdir", "touch"].includes(name)) return { countedAsRun: false, editCount: 1 };
  if (isPackageCheckCommand(name, args) || isDirectCheckCommand(name)) {
    return { countedAsRun: false, testsOrChecks: 1 };
  }
  if (name === "rg") {
    return args.includes("--files")
      ? { countedAsRun: false, listedFiles: 1 }
      : { countedAsRun: false, searchedCode: 1 };
  }
  if (["grep", "ag"].includes(name)) return { countedAsRun: false, searchedCode: 1 };
  if (name === "git" && args[0] === "grep") return { countedAsRun: false, searchedCode: 1 };
  if (["ls", "find", "tree", "fd"].includes(name)) return { countedAsRun: false, listedFiles: 1 };

  const readFiles = commandReadFiles(name, args);
  if (readFiles.length > 0) return { countedAsRun: false, readFiles };

  return { countedAsRun: true };
}

function stripCommandWrapper(tokens: string[]): [string, string[]] | null {
  let index = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(tokens[index] ?? "")) index += 1;
  const command = tokens[index];
  if (!command) return null;
  if (command === "bunx" || command === "npx") {
    const wrapped = tokens[index + 1];
    return wrapped ? [wrapped, tokens.slice(index + 2)] : [command, []];
  }
  return [command, tokens.slice(index + 1)];
}

function isPackageCheckCommand(name: string, args: string[]): boolean {
  if (!["bun", "npm", "pnpm", "yarn"].includes(name)) return false;
  const joined = args.join(" ").toLowerCase();
  return /\b(test|typecheck|check|lint|vitest|jest|playwright|tsc)\b/.test(joined);
}

function isDirectCheckCommand(name: string): boolean {
  return ["eslint", "jest", "playwright", "prettier", "tsc", "vitest"].includes(name);
}

function commandReadFiles(name: string, args: string[]): string[] {
  if (name === "cat" || name === "nl" || name === "head" || name === "tail" || name === "wc") {
    return likelyFileArgs(nonFlagArgs(args));
  }
  if (name === "sed") {
    const expressionIndex = args.findIndex((token) => token !== "-n" && !token.startsWith("--"));
    return likelyFileArgs(expressionIndex >= 0 ? nonFlagArgs(args.slice(expressionIndex + 1)) : []);
  }
  if (name === "awk" || name === "jq") {
    return likelyFileArgs(nonFlagArgs(args.slice(1)));
  }
  return [];
}

function likelyFileArgs(values: string[]): string[] {
  return values.filter((value) => {
    if (!value || value === "." || value === "-") return false;
    if (/^\d+$/.test(value)) return false;
    return true;
  });
}

function primaryClauses(counters: ActivityCounters): string[] {
  const clauses: string[] = [];
  const subagent = subagentClause(counters);
  if (subagent) clauses.push(subagent);
  if (counters.editCount > 0) clauses.push("made edits");
  const readCount = counters.readFiles.size || counters.readFileCount;
  if (readCount > 0) clauses.push(countClause("read", readCount, "file"));
  if (counters.searchedCode > 0) clauses.push("searched code");
  if (counters.listedFiles > 0) clauses.push("listed files");
  if (counters.testsOrChecks > 0) clauses.push(counters.testsOrChecks === 1 ? "ran checks" : `ran ${counters.testsOrChecks} checks`);
  if (counters.webSearches > 0) clauses.push("searched web");
  if (counters.imageCount > 0) clauses.push(countClause("read", counters.imageCount, "image"));
  if (counters.reasoningCount > 0) clauses.push("reasoned");
  if (counters.approvals > 0) clauses.push("requested approval");
  if (clauses.length === 0 && counters.controlCount > 0) clauses.push("updated context");
  return clauses;
}

function subagentClause(counters: ActivityCounters): string | null {
  const counts = subagentStatusCounts(counters);
  if (counts.failed > 0) return countSubagentClause(counts.failed, "failed");
  if (counts.blocked > 0) return countSubagentClause(counts.blocked, "blocked");
  if (counts.running > 0 && counts.completed === 0) {
    return countSubagentClause(counts.running, "running");
  }
  if (counts.completed > 0) return countSubagentClause(counts.completed, "completed");
  return null;
}

function setSubagentStatus(
  counters: ActivityCounters,
  activity: ActivityItem,
  status: SubagentActivityStatus,
): void {
  const key = activity.openSession?.sessionId ?? (activity.content.trim() || activity.id);
  const current = counters.subagentStatuses.get(key);
  if (!current || subagentStatusRank(status) > subagentStatusRank(current)) {
    counters.subagentStatuses.set(key, status);
  }
}

function subagentStatusCounts(counters: ActivityCounters): Record<SubagentActivityStatus, number> {
  const counts: Record<SubagentActivityStatus, number> = {
    blocked: 0,
    completed: 0,
    failed: 0,
    running: 0,
  };
  for (const status of counters.subagentStatuses.values()) counts[status] += 1;
  return counts;
}

function subagentStatusRank(status: SubagentActivityStatus): number {
  if (status === "running") return 1;
  if (status === "completed") return 2;
  if (status === "blocked") return 3;
  return 4;
}

function countSubagentClause(count: number, status: "blocked" | "completed" | "failed" | "running"): string {
  if (count === 1) return `subagent ${status}`;
  return `${count} subagents ${status}`;
}

function summaryKind(
  counters: ActivityCounters,
  clauses: string[],
  runClause: string,
): ActivityGroupSummaryKind {
  const activeKinds: ActivityGroupSummaryKind[] = [];
  if (counters.subagentStatuses.size > 0) activeKinds.push("subagent");
  if (counters.editCount > 0) activeKinds.push("edit");
  if (counters.readFiles.size > 0 || counters.readFileCount > 0) activeKinds.push("read");
  if (counters.searchedCode > 0) activeKinds.push("search");
  if (counters.listedFiles > 0) activeKinds.push("list");
  if (counters.webSearches > 0) activeKinds.push("web");
  if (counters.imageCount > 0) activeKinds.push("image");
  if (counters.reasoningCount > 0) activeKinds.push("reasoning");
  if (counters.approvals > 0) activeKinds.push("approval");
  if (counters.controlCount > 0) activeKinds.push("control");
  if (counters.testsOrChecks > 0 || runClause) activeKinds.push("command");
  return activeKinds[0] ?? "command";
}

function ranClause(count: number): string {
  return count === 1 ? "ran a command" : `ran ${count} commands`;
}

function countClause(verb: string, count: number, noun: string): string {
  if (count === 1) return `${verb} a ${noun}`;
  return `${verb} ${count} ${noun}s`;
}

function formatActivityClauses(primary: string[], runClause: string): string {
  if (primary.length === 0) return runClause ? capitalize(runClause) : "";
  if (runClause) return `${capitalize(formatList(primary))}, ${runClause}`;
  return capitalize(formatList(primary));
}

function addGenericLabel(labels: string[], label: string): void {
  const normalized = label.trim();
  if (!normalized) return;
  if (labels.includes(normalized)) return;
  labels.push(normalized);
}

function addOutcomeClause(clauses: string[], label: string): void {
  const clause = outcomeClauseForLabel(label);
  if (!clause || clauses.includes(clause)) return;
  clauses.push(clause);
}

function addReceiptClause(clauses: string[], activity: ActivityItem): void {
  const receipt = activity.receipt;
  if (!receipt) return;
  const clause = `${receipt.status} receipt ${shortId(receipt.id)} ${formatUsd(receipt.totalUsd)}`;
  if (clauses.includes(clause)) return;
  clauses.push(clause);
}

function outcomeClauseForLabel(label: string): string | null {
  switch (label.trim().toLowerCase()) {
    case "applied locally":
      return "applied locally";
    case "apply locally failed":
      return "apply locally failed";
    case "exported sandbox patch":
      return "exported patch";
    case "patch export failed":
      return "patch export failed";
    case "preserved sandbox source":
      return "preserved sandbox source";
    case "preserve failed":
      return "preserve failed";
    case "stopped sandbox":
      return "stopped sandbox";
    case "sandbox stop failed":
      return "sandbox stop failed";
    default:
      return null;
  }
}

function formatUsd(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("$") ? trimmed : `$${trimmed}`;
}

function shortId(value: string): string {
  const normalized = value.trim();
  if (normalized.length <= 14) return normalized;
  return `${normalized.slice(0, 6)}...${normalized.slice(-4)}`;
}

function formatGenericLabels(labels: string[]): string {
  if (labels.length === 0) return "";
  return capitalize(formatList(labels.map(sentenceFragment)));
}

function sentenceFragment(value: string): string {
  return value ? `${value[0]!.toLowerCase()}${value.slice(1)}` : value;
}

function formatList(values: string[]): string {
  if (values.length === 0) return "";
  if (values.length === 1) return values[0]!;
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values[values.length - 1]}`;
}

function capitalize(value: string): string {
  return value ? `${value[0]!.toUpperCase()}${value.slice(1)}` : value;
}

function summarizeSedCommand(tokens: string[]): string | null {
  const expressionIndex = tokens.findIndex((token, index) => index > 0 && token !== "-n" && !token.startsWith("--"));
  const expression = expressionIndex >= 0 ? tokens[expressionIndex] ?? "" : "";
  const files = expressionIndex >= 0 ? nonFlagArgs(tokens.slice(expressionIndex + 1)) : [];
  const lineMatch = /^(\d+)(?:,(\d+))?p$/.exec(expression);
  if (lineMatch) {
    const start = lineMatch[1]!;
    const end = lineMatch[2];
    const range = end ? `lines ${start}-${end}` : `line ${start}`;
    return files.length > 0 ? `Read ${range} of ${formatCommandTargets(files)}` : `Read ${range}`;
  }
  return files.length > 0 ? `Read ${formatCommandTargets(files)} with sed` : "Run sed";
}

function summarizeRipgrepCommand(tokens: string[]): string | null {
  const args = tokens.slice(1);
  if (args.includes("--files")) {
    const filters = nonFlagArgs(args.filter((token) => token !== "--files"));
    return filters.length > 0 ? `List files matching ${formatCommandTargets(filters)}` : "List files";
  }
  const positional = nonFlagArgs(args);
  const query = positional[0];
  const targets = positional.slice(1);
  if (!query) return "Search files";
  return targets.length > 0
    ? `Search for ${quoteCommandText(query)} in ${formatCommandTargets(targets)}`
    : `Search for ${quoteCommandText(query)}`;
}

function shellWords(command: string): string[] {
  const matches = command.match(/"([^"\\]|\\.)*"|'[^']*'|[^\s]+/g) ?? [];
  return matches.map((token) => unquoteShellToken(token)).filter(Boolean);
}

function unquoteShellToken(token: string): string {
  if ((token.startsWith("'") && token.endsWith("'")) || (token.startsWith("\"") && token.endsWith("\""))) {
    return token.slice(1, -1);
  }
  return token;
}

function isShellOperator(token: string): boolean {
  return ["|", "&&", "||", ";", ">", ">>", "<", "(", ")"].includes(token);
}

function nonFlagArgs(tokens: string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (!token.startsWith("-")) {
      values.push(token);
      continue;
    }
    if (flagTakesValue(token) && index + 1 < tokens.length) index += 1;
  }
  return values;
}

function flagTakesValue(flag: string): boolean {
  return ["-e", "-f", "-g", "--glob", "--type", "-t", "--context", "-C", "-A", "-B", "-m", "-n", "-c"].includes(flag);
}

function formatCommandTargets(values: string[]): string {
  if (values.length === 1) return values[0]!;
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values[0]} and ${values.length - 1} more`;
}

function quoteCommandText(value: string): string {
  return `"${value}"`;
}
