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
  goalContextUpdates: number;
  imageCount: number;
  listedFiles: number;
  readFileCount: number;
  readFiles: Set<string>;
  reasoningCount: number;
  runCount: number;
  searchedCode: number;
  subagentStatuses: Map<string, SubagentActivityStatus>;
  testsOrChecks: number;
  turnInterruptions: number;
  webSearches: number;
};

type SubagentActivityStatus =
  | "accepted"
  | "archived"
  | "blocked"
  | "completed"
  | "failed"
  | "needs revision"
  | "running"
  | "stale"
  | "submitted";

type CommandSummary = {
  countedAsRun: boolean;
  editCount?: number;
  listedFiles?: number;
  readFiles?: string[];
  searchedCode?: number;
  testsOrChecks?: number;
};

export function summarizeActivityGroup(activities: ActivityItem[]): ActivityGroupSummary {
  const childMessageSummary = summarizeChildMessageActivities(activities);
  if (childMessageSummary) return childMessageSummary;

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
  const singleCommandSummary =
    activities.length === 1 &&
    activities[0]?.kind === "command" &&
    activities[0].content &&
    outcomeClauses.length === 0 &&
    receiptClauses.length === 0
      ? summarizeShellCommand(activities[0].content, "completed")
      : null;
  const text =
    singleCommandSummary ||
    formatActivityClauses(clauses, runClause) ||
    genericSummary ||
    fallbackLabel ||
    "Ran command";

  return {
    kind: summaryKind(counters, runClause),
    text,
  };
}

export function activityGroupSummary(activities: ActivityItem[]): string {
  return summarizeActivityGroup(activities).text;
}

export function summarizeShellCommand(
  command: string,
  state: ActivityItem["state"] = "completed",
): string | null {
  const tokens = shellWords(command);
  if (tokens.length === 0) return null;
  const running = state === "running" || state === "pending";
  if (tokens.some(isShellOperator)) return running ? "Running shell command" : "Ran shell command";
  const executable = stripCommandWrapper(tokens);
  if (!executable) return null;
  const [name, args] = executable;

  if (name === "cat") {
    const files = nonFlagArgs(args);
    if (files.length === 0) return running ? "Reading standard input" : "Read standard input";
    return `${running ? "Reading" : "Read"} ${formatCommandTargets(files)}`;
  }
  if (name === "sed") {
    return commandSummaryForState(summarizeSedCommand([name, ...args]), running);
  }
  if (name === "rg") {
    return summarizeRipgrepCommand([name, ...args], running);
  }
  if (["grep", "ag"].includes(name) || (name === "git" && args[0] === "grep")) {
    return running ? "Searching code" : "Searched code";
  }
  if (["ls", "find", "tree", "fd"].includes(name)) {
    const targets = name === "ls" ? nonFlagArgs(args) : [];
    if (targets.length === 0) return running ? "Listing files" : "Listed files";
    return `${running ? "Listing" : "Listed"} files in ${formatCommandTargets(targets)}`;
  }
  if (["head", "tail", "nl", "wc", "awk", "jq"].includes(name)) {
    const files = commandReadFiles(name, args);
    if (files.length === 0) return running ? `Running ${name}` : `Ran ${name}`;
    return `${running ? "Reading" : "Read"} ${formatCommandTargets(files)}`;
  }
  if (name === "apply_patch") return running ? "Editing files" : "Edited files";
  if (name === "write_stdin") return running ? "Continuing command" : "Continued command";
  if (name === "wait") return running ? "Waiting for command" : "Waited for command";
  if (name === "js") return running ? "Running JavaScript" : "Ran JavaScript";
  if (name === "exec_command") return running ? "Running shell command" : "Ran shell command";
  if (name === "read_file") return running ? "Reading file" : "Read file";
  if (name === "view_image") return running ? "Viewing image" : "Viewed image";
  if (name === "update_plan") return running ? "Updating plan" : "Updated plan";
  if (name === "tool_search") return running ? "Searching tools" : "Searched tools";
  if (name === "rm") return running ? "Removing files" : "Removed files";
  if (name === "mv") return running ? "Moving files" : "Moved files";
  if (name === "cp") return running ? "Copying files" : "Copied files";
  if (name === "mkdir") return running ? "Creating directories" : "Created directories";
  if (name === "touch") return running ? "Creating files" : "Created files";
  if (name === "git") return summarizeGitCommand(args, running);
  if (isPackageCommand(name)) return summarizePackageCommand(name, args, running);
  if (isDirectCheckCommand(name)) return summarizeDirectCheckCommand(name, running);
  if (["curl", "wget"].includes(name)) return running ? "Fetching URL" : "Fetched URL";
  if (["node", "tsx", "python", "python3", "bash", "sh", "zsh"].includes(name)) {
    return running ? `Running ${displayExecutable(name)} script` : `Ran ${displayExecutable(name)} script`;
  }
  const executableLabel = displayExecutable(name);
  return running ? `Running ${executableLabel} command` : `Ran ${executableLabel} command`;
}

function summarizeGitCommand(args: string[], running: boolean): string {
  const subcommand = args.find((arg) => !arg.startsWith("-")) ?? "";
  if (subcommand === "status") return running ? "Checking Git status" : "Checked Git status";
  if (subcommand === "diff") return running ? "Reviewing changes" : "Reviewed changes";
  if (subcommand === "show" || subcommand === "log") return running ? "Reading Git history" : "Read Git history";
  if (subcommand === "add") return running ? "Staging changes" : "Staged changes";
  if (subcommand === "commit") return running ? "Committing changes" : "Committed changes";
  if (subcommand === "push") return running ? "Pushing changes" : "Pushed changes";
  if (subcommand === "pull" || subcommand === "fetch") return running ? "Fetching changes" : "Fetched changes";
  if (subcommand === "checkout" || subcommand === "switch") return running ? "Switching branches" : "Switched branches";
  if (subcommand === "branch") return running ? "Listing branches" : "Listed branches";
  return running ? "Running Git command" : "Ran Git command";
}

function summarizePackageCommand(name: string, args: string[], running: boolean): string {
  const joined = args.join(" ").toLowerCase();
  if (/\b(typecheck|tsc)\b/.test(joined)) return running ? "Checking types" : "Checked types";
  if (/\b(lint|eslint|prettier)\b/.test(joined)) return running ? "Running lint" : "Ran lint";
  if (/\b(test|vitest|jest|playwright)\b/.test(joined)) return running ? "Running tests" : "Ran tests";
  if (/\bbuild\b/.test(joined)) return running ? "Building project" : "Built project";
  if (/\b(install|add)\b/.test(joined)) return running ? "Installing dependencies" : "Installed dependencies";
  return running ? `Running ${displayExecutable(name)} command` : `Ran ${displayExecutable(name)} command`;
}

function summarizeDirectCheckCommand(name: string, running: boolean): string {
  if (name === "tsc") return running ? "Checking types" : "Checked types";
  if (name === "eslint" || name === "prettier") return running ? "Running lint" : "Ran lint";
  return running ? "Running tests" : "Ran tests";
}

function isPackageCommand(name: string): boolean {
  return ["bun", "npm", "pnpm", "yarn"].includes(name);
}

function displayExecutable(name: string): string {
  const executable = name.split("/").filter(Boolean).at(-1) ?? name;
  if (executable === "python" || executable === "python3") return "Python";
  if (executable === "node" || executable === "tsx") return "Node";
  if (["bash", "sh", "zsh"].includes(executable)) return "shell";
  if (executable === "git") return "Git";
  return executable;
}

function commandSummaryForState(summary: string | null, running: boolean): string | null {
  if (!summary || !running) return summary;
  if (summary.startsWith("Read ")) return `Reading ${summary.slice(5)}`;
  if (summary.startsWith("Run ")) return `Running ${summary.slice(4)}`;
  return summary;
}

function emptyCounters(): ActivityCounters {
  return {
    approvals: 0,
    controlCount: 0,
    editCount: 0,
    goalContextUpdates: 0,
    imageCount: 0,
    listedFiles: 0,
    readFileCount: 0,
    readFiles: new Set<string>(),
    reasoningCount: 0,
    runCount: 0,
    searchedCode: 0,
    subagentStatuses: new Map(),
    testsOrChecks: 0,
    turnInterruptions: 0,
    webSearches: 0,
  };
}

function summarizeChildMessageActivities(activities: ActivityItem[]): ActivityGroupSummary | null {
  if (activities.length === 0) return null;
  const messages = activities
    .map((activity) => activity.subagentMessage)
    .filter((message): message is NonNullable<ActivityItem["subagentMessage"]> => Boolean(message));
  if (messages.length === 0 || messages.length !== activities.length) return null;
  if (messages.length === 1) {
    const message = messages[0]!;
    return {
      kind: "subagent",
      text: `${message.direction === "received" ? "Child Message Received" : "Child Message Sent"}: ${message.summary}`,
    };
  }
  const receivedCount = messages.filter((message) => message.direction === "received").length;
  const sentCount = messages.length - receivedCount;
  const parts = [
    receivedCount > 0 ? countChildMessages(receivedCount, "received") : null,
    sentCount > 0 ? countChildMessages(sentCount, "sent") : null,
  ].filter((part): part is string => Boolean(part));
  return {
    kind: "subagent",
    text: capitalize(formatList(parts)),
  };
}

function countChildMessages(count: number, direction: "received" | "sent"): string {
  return count === 1 ? `child message ${direction}` : `${count} child messages ${direction}`;
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
    if (activity.controlKind === "goal_context") counters.goalContextUpdates += 1;
    if (activity.controlKind === "turn_aborted") counters.turnInterruptions += 1;
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
    setSubagentStatus(counters, activity, subagentActivityStatusFromLabel(label));
    return true;
  }
  if (label.includes("image")) {
    counters.imageCount += 1;
  return true;
}

function subagentActivityStatusFromLabel(label: string): SubagentActivityStatus {
  if (label.includes("failed")) return "failed";
  if (label.includes("blocked")) return "blocked";
  if (label.includes("stale")) return "stale";
  if (label.includes("needs revision")) return "needs revision";
  if (label.includes("archived")) return "archived";
  if (label.includes("accepted")) return "accepted";
  if (label.includes("submitted")) return "submitted";
  if (label.includes("completed")) return "completed";
  return "running";
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
  if (counters.reasoningCount > 0 && clauses.length === 0) clauses.push("thought through the request");
  if (counters.approvals > 0) clauses.push("requested approval");
  clauses.push(...controlClauses(counters));
  return clauses;
}

function controlClauses(counters: ActivityCounters): string[] {
  const clauses: string[] = [];
  if (counters.goalContextUpdates === 1) clauses.push("goal context updated");
  if (counters.goalContextUpdates > 1) clauses.push(`${counters.goalContextUpdates} goal context updates`);
  if (counters.turnInterruptions === 1) clauses.push("turn interrupted");
  if (counters.turnInterruptions > 1) clauses.push(`${counters.turnInterruptions} turns interrupted`);
  const otherControlUpdates = counters.controlCount - counters.goalContextUpdates - counters.turnInterruptions;
  if (otherControlUpdates === 1) clauses.push("context updated");
  if (otherControlUpdates > 1) clauses.push(`${otherControlUpdates} context updates`);
  return clauses;
}

function subagentClause(counters: ActivityCounters): string | null {
  const counts = subagentStatusCounts(counters);
  if (counts.failed > 0) return countSubagentClause(counts.failed, "failed");
  if (counts.blocked > 0) return countSubagentClause(counts.blocked, "blocked");
  if (counts.stale > 0) return countSubagentClause(counts.stale, "stale");
  if (counts["needs revision"] > 0) return countSubagentClause(counts["needs revision"], "needs revision");
  if (counts.submitted > 0) return countSubagentClause(counts.submitted, "submitted");
  if (counts.running > 0 && counts.completed === 0 && counts.accepted === 0) {
    return countSubagentClause(counts.running, "running");
  }
  if (counts.accepted > 0) return countSubagentClause(counts.accepted, "accepted");
  if (counts.completed > 0) return countSubagentClause(counts.completed, "completed");
  if (counts.archived > 0) return countSubagentClause(counts.archived, "archived");
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
    accepted: 0,
    archived: 0,
    blocked: 0,
    completed: 0,
    failed: 0,
    "needs revision": 0,
    running: 0,
    stale: 0,
    submitted: 0,
  };
  for (const status of counters.subagentStatuses.values()) counts[status] += 1;
  return counts;
}

function subagentStatusRank(status: SubagentActivityStatus): number {
  if (status === "running") return 1;
  if (status === "submitted") return 2;
  if (status === "accepted" || status === "completed" || status === "archived") return 3;
  if (status === "needs revision") return 4;
  if (status === "blocked") return 5;
  if (status === "stale") return 6;
  return 7;
}

function countSubagentClause(count: number, status: SubagentActivityStatus): string {
  if (count === 1) return `subagent ${status}`;
  return `${count} subagents ${status}`;
}

function summaryKind(
  counters: ActivityCounters,
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
  return capitalize(formatList(runClause ? [...primary, runClause] : primary));
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

function summarizeRipgrepCommand(tokens: string[], running = false): string | null {
  const args = tokens.slice(1);
  if (args.includes("--files")) {
    const filters = nonFlagArgs(args.filter((token) => token !== "--files"));
    return filters.length > 0
      ? `${running ? "Listing" : "Listed"} files matching ${formatCommandTargets(filters)}`
      : running
        ? "Listing files"
        : "Listed files";
  }
  const positional = nonFlagArgs(args);
  const query = positional[0];
  const targets = positional.slice(1);
  if (!query) return running ? "Searching files" : "Searched files";
  return targets.length > 0
    ? `${running ? "Searching" : "Searched"} for ${quoteCommandText(query)} in ${formatCommandTargets(targets)}`
    : `${running ? "Searching" : "Searched"} for ${quoteCommandText(query)}`;
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
