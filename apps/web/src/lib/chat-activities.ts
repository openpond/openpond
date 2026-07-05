import type { RuntimeEvent } from "@openpond/contracts";
import type { ActivityItem, ChatMessage } from "./app-models";
import { isWorkspaceImagePath, workspaceFileName } from "./workspace-images";
import { asRecord, findLast, parseMaybeJson, stringValue } from "./chat-message-utils";
import {
  connectedAppToolActivityContent,
  connectedAppToolActivityLabel,
} from "./connected-app-provider-activity";

export { activityGroupSummary, summarizeActivityGroup } from "./chat-activity-summary";

export function appendActivityMessage(messages: ChatMessage[], item: RuntimeEvent): void {
  const activity = activityFromEvent(item);
  const previous = messages[messages.length - 1];
  if (previous?.role === "activity_group" && previous.turnId === item.turnId) {
    previous.activities = appendActivityToList(previous.activities ?? [], item, activity);
    previous.timestamp = item.timestamp;
    return;
  }

  messages.push({
    id: item.id,
    role: "activity_group",
    activities: [activity],
    timestamp: item.timestamp,
    turnId: item.turnId,
  });
}

export function appendActivityToList(
  activities: ActivityItem[],
  item: RuntimeEvent,
  activity = activityFromEvent(item),
): ActivityItem[] {
  const next = [...activities];
  if (mergeStreamedTextActivity(next, item, activity)) return next;
  if (mergeCommandActivity(next, item, activity)) return next;
  return [...next, activity];
}

export function isCompactionEvent(item: RuntimeEvent): boolean {
  return (
    item.name === "session.compaction.started" ||
    item.name === "session.compaction.completed" ||
    item.name === "session.compaction.failed"
  );
}

export function appendCompactionStatus(messages: ChatMessage[], item: RuntimeEvent): void {
  const next: ChatMessage = {
    id: item.id,
    role: "status_divider",
    content: compactionStatusText(item),
    timestamp: item.timestamp,
    turnId: item.turnId,
    statusKind: "compaction",
    statusState: compactionStatusState(item),
    statusTone: compactionStatusTone(item),
  };

  if (item.name !== "session.compaction.started") {
    const running = findLast(
      messages,
      (candidate) =>
        candidate.role === "status_divider" &&
        candidate.statusKind === "compaction" &&
        candidate.statusState === "running" &&
        candidate.turnId === item.turnId
    );
    if (running) {
      running.id = next.id;
      running.content = next.content;
      running.timestamp = next.timestamp;
      running.statusState = next.statusState;
      running.statusTone = next.statusTone;
      return;
    }
  }

  messages.push(next);
}

function compactionStatusText(item: RuntimeEvent): string {
  const reason = compactionReason(item);
  if (item.name === "session.compaction.started") return reason === "auto" ? "Auto compacting context" : "Compacting context";
  if (item.name === "session.compaction.completed") return reason === "auto" ? "Auto compacted context" : "Compacted context";
  return reason === "auto" ? "Auto compaction failed" : "Context compaction failed";
}

function compactionStatusState(item: RuntimeEvent): ChatMessage["statusState"] {
  if (item.name === "session.compaction.started") return "running";
  if (item.name === "session.compaction.completed") return "completed";
  return "failed";
}

function compactionStatusTone(item: RuntimeEvent): ChatMessage["statusTone"] {
  if (item.name === "session.compaction.failed") return "danger";
  if (item.name === "session.compaction.completed") return "success";
  return "info";
}

function compactionReason(item: RuntimeEvent): "auto" | "manual" {
  const data = asRecord(item.data);
  return data?.reason === "auto" ? "auto" : "manual";
}

function activityFromEvent(item: RuntimeEvent): ActivityItem {
  const imagePreview = activityImagePreview(item);
  const kind = commandActivityKind(item);
  const controlKind = controlActivityKind(item);
  return {
    id: item.id,
    label: activityLabel(item),
    content: activityContent(item, imagePreview),
    timestamp: item.timestamp,
    ...(kind ? { kind } : {}),
    ...(controlKind ? { kind: "control" as const, controlKind } : {}),
    ...(kind ? { callId: activityCallId(item) ?? undefined } : {}),
    ...(kind && item.name === "command.output" ? { detail: cleanCommandOutput(item.output ?? "") } : {}),
    state: activityState(item),
    ...(imagePreview ? { imagePreview } : {}),
  };
}

function mergeCommandActivity(activities: ActivityItem[], item: RuntimeEvent, activity: ActivityItem): boolean {
  if (item.name === "tool.completed") {
    const existing = findMatchingCommandActivity(activities, item);
    if (!existing) return false;
    existing.label = item.status === "failed" ? "Failed" : "Ran";
    existing.state = activity.state;
    existing.timestamp = item.timestamp;
    const output = cleanCommandOutput(item.output ?? "");
    if (output && output !== existing.content) existing.detail = appendCommandOutput(existing.detail, output);
    return true;
  }

  if (item.name === "command.output") {
    const existing = findMatchingCommandActivity(activities, item);
    if (!existing) return false;
    const output = cleanCommandOutput(item.output ?? "");
    if (output) existing.detail = appendCommandOutput(existing.detail, output);
    existing.timestamp = item.timestamp;
    if (existing.state !== "completed" && existing.state !== "failed") existing.state = "running";
    return true;
  }

  return false;
}

function mergeStreamedTextActivity(activities: ActivityItem[], item: RuntimeEvent, activity: ActivityItem): boolean {
  if (item.name !== "assistant.delta" && item.name !== "assistant.reasoning.delta") return false;
  const previous = activities[activities.length - 1];
  if (!previous || previous.label !== activity.label || previous.kind || previous.controlKind) return false;
  previous.content = `${previous.content}${activity.content}`;
  previous.timestamp = item.timestamp;
  return true;
}

function findMatchingCommandActivity(activities: ActivityItem[], item: RuntimeEvent): ActivityItem | null {
  const callId = activityCallId(item);
  if (callId) {
    const byCallId = findLast(activities, (candidate) => candidate.kind === "command" && candidate.callId === callId);
    if (byCallId) return byCallId;
  }
  return findLast(activities, (candidate) => candidate.kind === "command");
}

function activityState(item: RuntimeEvent): ActivityItem["state"] {
  if (item.name === "turn.interrupted") return "failed";
  if (item.status === "failed") return "failed";
  if (item.status === "pending" || item.name === "approval.requested") return "pending";
  if (item.name === "tool.started" || item.name === "workspace_action") return "running";
  if (item.name === "command.output") return "running";
  if (item.name === "tool.completed" || item.name === "workspace_action_result") return "completed";
  if (item.status === "started") return "running";
  if (item.status === "completed") return "completed";
  return undefined;
}

function activityLabel(item: RuntimeEvent): string {
  if (item.name === "assistant.reasoning.delta") return "Reasoning";
  if (isCodexGoalContextEvent(item)) return "Goal context";
  if (item.name === "turn.interrupted") return "Turn aborted";
  if (isViewImageEvent(item) && item.name === "tool.started") return "Reading image";
  if (isViewImageEvent(item) && item.name === "tool.completed") return "Read image";
  if (item.action === "resource_search" && item.name === "tool.started") return "Searching resources";
  if (item.action === "resource_search" && item.name === "tool.completed") return "Searched resources";
  if (item.action === "resource_read" && item.name === "tool.started") return "Reading resource";
  if (item.action === "resource_read" && item.name === "tool.completed") return "Read resource";
  if (item.action === "web_search" && item.name === "tool.started") return "Searching web";
  if (item.action === "web_search" && item.name === "tool.completed") return "Searched web";
  if (item.action === "openpond_action_search" && item.name === "tool.started") return "Searching actions";
  if (item.action === "openpond_action_search" && item.name === "tool.completed") return "Searched actions";
  if (item.action === "openpond_action_run" && item.name === "tool.started") return "Running OpenPond action";
  if (item.action === "openpond_action_run" && item.name === "tool.completed") return "Ran OpenPond action";
  const connectedAppLabel = connectedAppToolActivityLabel(item);
  if (connectedAppLabel) return connectedAppLabel;
  const browserLabel = browserToolActivityLabel(item);
  if (browserLabel) return browserLabel;
  const capabilityLabel = capabilityToolActivityLabel(item);
  if (capabilityLabel) return capabilityLabel;
  if (item.name === "skill.selected") return "Selected skill";
  if (item.name === "skill.loaded") return "Loaded skill";
  if (item.name === "skill.load_failed") return "Skill load failed";
  if (item.name === "tool.started") return "Started";
  if (item.name === "tool.completed") return "Ran";
  if (item.name === "command.output") return "Output";
  if (item.name === "workspace_action" || item.name === "workspace_action_result") {
    return workspaceActivityLabel(item);
  }
  if (item.name === "approval.requested") return "Approval requested";
  if (item.name === "session.compaction.started") return "Compacting context";
  if (item.name === "session.compaction.completed") return "Compacted conversation context";
  if (item.name === "session.compaction.failed") return "Context compaction failed";
  return item.name.replace(".", " ");
}

const WORKSPACE_ACTIVITY_LABELS: Record<string, { started: string; completed: string; failed?: string; pending?: string }> = {
  workspace_status: { started: "Checking workspace", completed: "Checked workspace" },
  resource_search: { started: "Searching resources", completed: "Searched resources" },
  resource_read: { started: "Reading resource", completed: "Read resource" },
  list_files: { started: "Listing files", completed: "Listed files" },
  read_files: { started: "Reading files", completed: "Read files" },
  search_files: { started: "Searching files", completed: "Searched files" },
  preview_write_files: { started: "Previewing files", completed: "Previewed files" },
  preview_write_file: { started: "Previewing file", completed: "Previewed file" },
  preview_edit_file: { started: "Previewing edit", completed: "Previewed edit" },
  preview_delete_file: { started: "Previewing delete", completed: "Previewed delete" },
  write_files: { started: "Editing files", completed: "Edited files", failed: "File checks failed" },
  write_file: { started: "Editing file", completed: "Edited file", failed: "File checks failed" },
  edit_file: { started: "Editing file", completed: "Edited file", failed: "File checks failed" },
  delete_file: { started: "Deleting file", completed: "Deleted file", failed: "File checks failed" },
  validate_sandbox_template: { started: "Validating template", completed: "Validated template", failed: "Template validation failed" },
  build_sandbox_template: { started: "Building template", completed: "Built template", failed: "Template build failed" },
  run_sandbox_template: { started: "Running sandbox template", pending: "Sandbox template log", completed: "Ran sandbox template", failed: "Sandbox template failed" },
  git_status: { started: "Checking git status", completed: "Checked git status" },
  git_fetch: { started: "Fetching git", completed: "Fetched git", failed: "Git fetch failed" },
  git_commit: { started: "Committing changes", completed: "Committed changes", failed: "Commit failed" },
  git_push: { started: "Pushing changes", completed: "Pushed changes", failed: "Push failed" },
  publish_openpond_repo: { started: "Publishing to OpenPond", completed: "Published to OpenPond", failed: "Publish failed" },
  upload_cloud_source: { started: "Uploading source", completed: "Uploaded source", failed: "Upload failed" },
  sandbox_create: { started: "Starting sandbox", completed: "Started sandbox", failed: "Sandbox start failed" },
  sandbox_status: { started: "Checking sandbox", completed: "Checked sandbox", failed: "Sandbox status failed" },
  sandbox_list_files: { started: "Listing sandbox files", completed: "Listed sandbox files", failed: "Sandbox file list failed" },
  sandbox_read_file: { started: "Reading sandbox file", completed: "Read sandbox file", failed: "Sandbox file read failed" },
  sandbox_search_files: { started: "Searching sandbox files", completed: "Searched sandbox files", failed: "Sandbox search failed" },
  sandbox_run_action: { started: "Running sandbox action", completed: "Ran sandbox action", failed: "Sandbox action failed" },
  sandbox_upload_file: { started: "Uploading file", completed: "Uploaded file", failed: "Upload failed" },
  sandbox_write_file: { started: "Writing sandbox file", completed: "Wrote sandbox file", failed: "Write failed" },
  sandbox_edit_file: { started: "Editing sandbox file", completed: "Edited sandbox file", failed: "Edit failed" },
  sandbox_delete_file: { started: "Deleting sandbox file", completed: "Deleted sandbox file", failed: "Delete failed" },
  sandbox_mkdir: { started: "Creating sandbox directory", completed: "Created sandbox directory", failed: "Directory create failed" },
  sandbox_move_file: { started: "Moving sandbox file", completed: "Moved sandbox file", failed: "Move failed" },
  sandbox_exec: { started: "Running sandbox command", completed: "Ran sandbox command", failed: "Sandbox command failed" },
  sandbox_git_status: { started: "Checking sandbox git", completed: "Checked sandbox git" },
  sandbox_git_diff: { started: "Reading sandbox diff", completed: "Read sandbox diff" },
  sandbox_git_export_patch: { started: "Exporting sandbox patch", completed: "Exported sandbox patch", failed: "Patch export failed" },
  sandbox_git_branch: { started: "Switching sandbox branch", completed: "Switched sandbox branch", failed: "Branch failed" },
  sandbox_git_commit: { started: "Committing sandbox changes", completed: "Committed sandbox changes", failed: "Commit failed" },
  sandbox_git_pull: { started: "Pulling sandbox changes", completed: "Pulled sandbox changes", failed: "Pull failed" },
  sandbox_git_push: { started: "Pushing sandbox changes", completed: "Pushed sandbox changes", failed: "Push failed" },
  sandbox_preserve_source: { started: "Preserving sandbox source", completed: "Preserved sandbox source", failed: "Preserve failed" },
  sandbox_promote_source: { started: "Promoting sandbox source", completed: "Promoted sandbox source", failed: "Promote failed" },
  sandbox_logs: { started: "Reading sandbox logs", completed: "Read sandbox logs", failed: "Sandbox logs failed" },
  sandbox_receipts: { started: "Reading sandbox receipts", completed: "Read sandbox receipts", failed: "Sandbox receipts failed" },
  sandbox_stop: { started: "Stopping sandbox", completed: "Stopped sandbox", failed: "Sandbox stop failed" },
  file_change: { started: "Editing files", completed: "Edited files" },
};

function workspaceActivityLabel(item: RuntimeEvent): string {
  const action = item.action ?? "";
  const labels = WORKSPACE_ACTIVITY_LABELS[action] ?? { started: "Running workspace action", completed: "Workspace action completed", failed: "Workspace action failed" };
  if (item.name === "workspace_action") return item.status === "pending" ? labels.pending ?? labels.started : labels.started;
  if (item.status === "failed") return labels.failed ?? `${labels.completed} failed`;
  return labels.completed;
}

function activityContent(item: RuntimeEvent, imagePreview?: ActivityItem["imagePreview"]): string {
  if (item.name === "assistant.reasoning.delta") return item.output ?? "";
  if (imagePreview) return imagePreview.path;
  const marker = codexControlMessage(item.output ?? "");
  if (marker) return marker.text;
  if (isCodexGoalContextEvent(item) || item.name === "turn.interrupted") return item.output ?? item.error ?? "";
  const browserContent = browserToolActivityContent(item);
  if (browserContent) return browserContent;
  const capabilityContent = capabilityToolActivityContent(item);
  if (capabilityContent) return capabilityContent;
  const connectedAppContent = connectedAppToolActivityContent(item);
  if (connectedAppContent) return connectedAppContent;
  const command = commandTextFromEvent(item);
  if (command) return command;
  if (item.name === "command.output") return cleanCommandOutput(item.output ?? "");
  if (item.name === "tool.started" || item.name === "tool.completed") {
    const data = item.data;
    if (data && typeof data === "object") {
      const command = (data as { command?: unknown }).command;
      if (typeof command === "string" && command.trim()) return command;
      const tool = (data as { tool?: unknown }).tool;
      if (typeof tool === "string" && tool.trim()) return tool;
      const type = (data as { type?: unknown }).type;
      if (typeof type === "string" && type.trim()) return type;
    }
  }
  if (
    item.name === "session.compaction.started" ||
    item.name === "session.compaction.completed" ||
    item.name === "session.compaction.failed"
  ) {
    return item.error ?? item.output ?? "";
  }
  return item.output ?? item.action ?? "";
}

function capabilityToolActivityLabel(item: RuntimeEvent): string | null {
  if (item.name !== "tool.started" && item.name !== "tool.completed") return null;
  const failed = item.status === "failed";
  if (item.action === "openpond_create_pipeline") {
    if (item.name === "tool.started") return "Starting Create Pipeline";
    return failed ? "Create Pipeline failed" : "Started Create Pipeline";
  }
  if (item.action === "openpond_profile_skill_goal") {
    if (item.name === "tool.started") return "Starting profile skill goal";
    return failed ? "Profile skill goal failed" : "Started profile skill goal";
  }
  if (item.action === "openpond_goal_control") {
    if (item.name === "tool.started") return "Updating goal";
    return failed ? "Goal update failed" : "Updated goal";
  }
  return null;
}

function browserToolActivityLabel(item: RuntimeEvent): string | null {
  if (item.name !== "tool.started" && item.name !== "tool.completed") return null;
  const failed = item.status === "failed";
  const completed = item.name === "tool.completed";
  switch (item.action) {
    case "openpond_browser_open":
      return completed ? (failed ? "Browser open failed" : "Opened browser") : "Opening browser";
    case "openpond_browser_snapshot":
      return completed ? (failed ? "Browser capture failed" : "Captured browser") : "Capturing browser";
    case "openpond_browser_move_cursor":
      return completed ? (failed ? "Cursor move failed" : "Moved browser cursor") : "Moving browser cursor";
    case "openpond_browser_click":
      return completed ? (failed ? "Browser click failed" : "Clicked browser") : "Clicking browser";
    case "openpond_browser_type":
      return completed ? (failed ? "Browser typing failed" : "Typed in browser") : "Typing in browser";
    case "openpond_browser_key":
      return completed ? (failed ? "Browser key failed" : "Pressed browser key") : "Pressing browser key";
    case "openpond_browser_scroll":
      return completed ? (failed ? "Browser scroll failed" : "Scrolled browser") : "Scrolling browser";
    default:
      return null;
  }
}

function browserToolActivityContent(item: RuntimeEvent): string | null {
  if (!item.action?.startsWith("openpond_browser_")) return null;
  const result = asRecord(asRecord(item.data)?.result);
  const output = stringValue(result, ["output"]);
  if (output) return output;
  const parsedOutput = asRecord(parseMaybeJson(item.output ?? ""));
  const parsedMessage = stringValue(parsedOutput, ["output"]);
  if (parsedMessage) return parsedMessage;
  const args = asRecord(item.args);
  const url = stringValue(args, ["url"]);
  if (url) return url;
  if (item.action === "openpond_browser_type") return "Text redacted";
  return item.error ?? item.output ?? item.action;
}

function capabilityToolActivityContent(item: RuntimeEvent): string | null {
  if (
    item.action !== "openpond_create_pipeline" &&
    item.action !== "openpond_profile_skill_goal" &&
    item.action !== "openpond_goal_control"
  ) {
    return null;
  }
  const result = asRecord(asRecord(item.data)?.result);
  const resultStep = stringValue(result, ["nextStep"]);
  if (resultStep) return resultStep;
  const parsedOutput = asRecord(parseMaybeJson(item.output ?? ""));
  const output = stringValue(parsedOutput, ["output"]);
  if (output) return output;
  const args = asRecord(item.args);
  const reason = stringValue(args, ["reason"]);
  if (reason) return reason;
  const objective = stringValue(args, ["objective"]);
  if (objective) return objective;
  return item.error ?? null;
}

function commandActivityKind(item: RuntimeEvent): ActivityItem["kind"] | undefined {
  if (item.name === "command.output") return "command";
  if (item.name !== "tool.started" && item.name !== "tool.completed") return undefined;
  const data = asRecord(item.data);
  const type = stringValue(data, ["type"]);
  const tool = stringValue(data, ["tool", "toolName", "tool_name", "name", "functionName", "function_name"]);
  if (item.action === "commandExecution" || type === "commandExecution") return "command";
  if (commandTextFromEvent(item)) return "command";
  if (tool && /(^|[._-])exec_command$/i.test(tool)) return "command";
  return undefined;
}

function controlActivityKind(item: RuntimeEvent): ActivityItem["controlKind"] | undefined {
  if (item.name === "turn.interrupted") return "turn_aborted";
  if (isCodexGoalContextEvent(item)) return "goal_context";
  return undefined;
}

function commandTextFromEvent(item: RuntimeEvent): string | null {
  const data = asRecord(item.data);
  const type = stringValue(data, ["type"]);
  const tool = stringValue(data, ["tool", "toolName", "tool_name", "name", "functionName", "function_name"]);
  const direct =
    stringValue(data, ["command", "cmd"]) ??
    stringValue(asRecord(data?.input), ["command", "cmd"]) ??
    stringValue(asRecord(data?.arguments), ["command", "cmd"]) ??
    commandFromJsonString(stringValue(data, ["arguments", "args", "input"]));
  if (direct) return direct;
  if (
    item.name === "tool.started" &&
    (item.action === "commandExecution" || type === "commandExecution" || /(^|[._-])exec_command$/i.test(tool ?? ""))
  ) {
    return item.output?.trim() || null;
  }
  return null;
}

function commandFromJsonString(value: string | null): string | null {
  if (!value) return null;
  const parsed = parseMaybeJson(value);
  const record = asRecord(parsed);
  return stringValue(record, ["command", "cmd"]);
}

function activityCallId(item: RuntimeEvent): string | null {
  const data = asRecord(item.data);
  return stringValue(data, ["callId", "call_id", "id", "itemId", "item_id"]);
}

function cleanCommandOutput(value: string): string {
  let output = value.replace(/\r\n/g, "\n").trim();
  if (!output) return "";
  const marker = "\nOutput:\n";
  const markerIndex = output.indexOf(marker);
  if (markerIndex >= 0 && looksLikeCommandEnvelope(output.slice(0, markerIndex))) {
    output = output.slice(markerIndex + marker.length).trim();
  }
  output = output.replace(/^Total output lines: \d+\n\n/, "");
  return output.trim();
}

function looksLikeCommandEnvelope(header: string): boolean {
  return (
    /^(Chunk ID|Exit code):/m.test(header) &&
    /Wall time:/m.test(header)
  );
}

function appendCommandOutput(existing: string | undefined, next: string): string {
  const current = existing ?? "";
  if (!current) return next;
  if (current === next || current.includes(next)) return current;
  if (next.includes(current)) return next;
  const separator = current.endsWith("\n") || next.startsWith("\n") ? "" : "\n";
  return `${current}${separator}${next}`;
}

function activityImagePreview(item: RuntimeEvent): ActivityItem["imagePreview"] | undefined {
  if (!isViewImageEvent(item)) return undefined;
  const data = asRecord(item.data);
  const previewPath = typeof data?.openpondImagePreviewPath === "string" ? data.openpondImagePreviewPath : null;
  const fallbackPath = previewPath ?? findImagePathValue(item.data) ?? findImagePathValue(item.args) ?? findImagePathValue(item.output);
  if (!fallbackPath || !isWorkspaceImagePath(fallbackPath)) return undefined;
  return {
    path: fallbackPath,
    appId: item.appId ?? null,
    title: workspaceFileName(fallbackPath),
  };
}

function isViewImageEvent(item: RuntimeEvent): boolean {
  if (item.name !== "tool.started" && item.name !== "tool.completed") return false;
  const data = asRecord(item.data);
  if (typeof data?.openpondImagePreviewPath === "string" && data.openpondImagePreviewPath.trim()) return true;
  const candidates = [
    item.output,
    item.action,
    stringValue(data, ["tool", "toolName", "tool_name", "name", "functionName", "function_name", "command"]),
    stringValue(asRecord(data?.input), ["tool", "toolName", "tool_name", "name"]),
    stringValue(asRecord(data?.arguments), ["tool", "toolName", "tool_name", "name"]),
    stringValue(asRecord(data?.args), ["tool", "toolName", "tool_name", "name"]),
  ].filter((value): value is string => Boolean(value));
  return candidates.some((value) => value.toLowerCase().includes("view_image"));
}

function findImagePathValue(value: unknown, depth = 0, key = ""): string | null {
  if (depth > 5 || value == null) return null;
  if (typeof value === "string") {
    if (isImagePathKey(key) && isWorkspaceImagePath(value.trim())) return value.trim();
    const parsed = parseMaybeJson(value);
    if (parsed !== null) {
      const nested = findImagePathValue(parsed, depth + 1, key);
      if (nested) return nested;
    }
    return extractImagePathFromText(value);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const candidate = findImagePathValue(item, depth + 1, key);
      if (candidate) return candidate;
    }
    return null;
  }
  const record = asRecord(value);
  if (!record) return null;
  for (const [childKey, child] of Object.entries(record)) {
    if (!isImagePathKey(childKey)) continue;
    const candidate = findImagePathValue(child, depth + 1, childKey);
    if (candidate) return candidate;
  }
  for (const [childKey, child] of Object.entries(record)) {
    if (isImagePathKey(childKey)) continue;
    const candidate = findImagePathValue(child, depth + 1, childKey);
    if (candidate) return candidate;
  }
  return null;
}

function isImagePathKey(key: string): boolean {
  return /^(path|filePath|filepath|imagePath|image|localPath|uri|url)$/i.test(key);
}

function extractImagePathFromText(value: string): string | null {
  const match = /(?:file:\/\/)?(?:\/|\.\/|[\w.-]+\/)[^\s"'`<>]+\.(?:avif|gif|jpe?g|png|webp)\b/i.exec(value);
  if (!match) return null;
  if (!match[0].startsWith("file://")) return match[0];
  try {
    return decodeURIComponent(new URL(match[0]).pathname);
  } catch {
    return match[0].replace(/^file:\/\//i, "");
  }
}

type CodexControlMessage = {
  kind: "goal_context" | "turn_aborted";
  text: string;
};

export function codexControlMessage(content: string): CodexControlMessage | null {
  const trimmed = content.trim();
  const match = /^<(goal_context|turn_aborted)>\s*([\s\S]*?)\s*<\/\1>$/.exec(trimmed);
  if (match) {
    const kind = match[1] as CodexControlMessage["kind"];
    return {
      kind,
      text: match[2]?.trim() || defaultCodexControlText(kind),
    };
  }
  if (trimmed === "<turn_aborted>") return { kind: "turn_aborted", text: defaultCodexControlText("turn_aborted") };
  if (trimmed === "<goal_context>") return { kind: "goal_context", text: defaultCodexControlText("goal_context") };
  return null;
}

function defaultCodexControlText(kind: CodexControlMessage["kind"]): string {
  return kind === "turn_aborted" ? "The previous turn was interrupted." : "Goal context updated.";
}

export function isCodexGoalContextEvent(item: RuntimeEvent): boolean {
  return item.name === "diagnostic" && asRecord(item.data)?.kind === "goal_context";
}
