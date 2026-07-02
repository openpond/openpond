import type { RuntimeEvent } from "@openpond/contracts";
import type {
  ActionRunChildCall,
  ActionRunRef,
  ActionRunSummary,
  ChatMessage,
} from "./app-models";
import { asRecord, findLast, stringValue } from "./chat-message-utils";

export function appendActionRunMessage(
  messages: ChatMessage[],
  item: RuntimeEvent,
  actionRun: ActionRunSummary,
): void {
  if (item.name === "workspace_action_result") {
    const existing = findLast(
      messages,
      (candidate) =>
        candidate.role === "assistant" &&
        candidate.turnId === item.turnId &&
        candidate.actionRun?.actionName === actionRun.actionName,
    );
    if (existing?.actionRun) {
      existing.id = item.id;
      existing.timestamp = item.timestamp;
      existing.actionRun = {
        ...existing.actionRun,
        ...actionRun,
        refs: uniqueActionRunRefs([
          ...existing.actionRun.refs,
          ...actionRun.refs,
        ]),
        childCalls:
          actionRun.childCalls.length > 0
            ? actionRun.childCalls
            : existing.actionRun.childCalls,
      };
      return;
    }
  }

  messages.push({
    id: item.id,
    role: "assistant",
    actionRun,
    timestamp: item.timestamp,
    turnId: item.turnId,
  });
}

export function actionRunSummaryFromEvent(item: RuntimeEvent): ActionRunSummary | null {
  if (item.name !== "workspace_action" && item.name !== "workspace_action_result") {
    return null;
  }
  const data = asRecord(item.data);
  const args = asRecord(item.args);
  const actionName =
    stringValue(args, ["actionName"]) ??
    stringValue(asRecord(args?.input), ["actionName"]) ??
    actionNameFromPayload(data) ??
    actionNameFromPayload(asRecord(data?.run)) ??
    actionNameFromPayload(asRecord(data?.agentRun));
  const isSandboxAction =
    item.action === "sandbox_run_action" ||
    item.action === "profile_run_action" ||
    Boolean(actionName) ||
    data?.openPondActionRun === true ||
    data?.openPondProfileActionRun === true;
  if (!isSandboxAction || !actionName) return null;

  const run = asRecord(data?.run) ?? asRecord(data?.agentRun);
  const metadata = asRecord(run?.metadata);
  const actionSummary =
    asRecord(data?.actionSummary) ??
    asRecord(run?.actionSummary) ??
    asRecord(metadata?.actionSummary);
  const actionPayload =
    asRecord(data?.action) ??
    actionSummary ??
    asRecord(metadata?.selectedAction) ??
    null;
  const responseSummary =
    asRecord(data?.responseSummary) ??
    asRecord(run?.responseSummary) ??
    asRecord(metadata?.responseSummary);
  const sourceSummary =
    asRecord(data?.sourceSummary) ??
    asRecord(run?.sourceSummary) ??
    asRecord(metadata?.sourceSummary);
  const traceSummary =
    asRecord(data?.traceSummary) ??
    asRecord(run?.traceSummary) ??
    asRecord(metadata?.traceSummary);
  const evalSummary =
    asRecord(data?.evalSummary) ??
    asRecord(run?.evalSummary) ??
    asRecord(metadata?.evalSummary);
  const refs = uniqueActionRunRefs([
    ...actionRunRefs("artifact", data?.artifactRefs, "Artifact"),
    ...actionRunRefs("artifact", actionPayload?.artifactRefs, "Artifact"),
    ...actionRunRefs("artifact", actionSummary?.artifactRefs, "Artifact"),
    ...actionRunRefs("artifact", responseSummary?.artifactRefs, "Artifact"),
    ...actionRunRefs("trace", data?.traceArtifactRefs, "Trace"),
    ...actionRunRefs("trace", traceSummary?.artifactRefs, "Trace"),
    ...actionRunRefs("eval", data?.evalResultArtifactRefs, "Eval"),
    ...actionRunRefs("eval", evalSummary?.artifactRefs, "Eval"),
    ...actionRunRefs("output", data?.outputRefs, "Output"),
  ]);
  const sourceRef = stringValue(sourceSummary, ["sourceRef", "ref"]);
  if (sourceRef) {
    refs.push({
      id: actionRunRefId("source", sourceRef),
      kind: "source",
      label: "Source",
      target: sourceRef,
    });
  }

  return {
    actionName,
    title:
      stringValue(actionPayload, ["label", "title", "name"]) ??
      stringValue(metadata, ["selectedActionLabel"]) ??
      titleFromActionName(actionName),
    status: actionRunStatus(item, responseSummary, run),
    responseText:
      stringValue(responseSummary, ["text", "summary", "message"]) ??
      (item.name === "workspace_action_result" ? item.output?.trim() || null : null),
    runId:
      stringValue(run, ["id", "runId"]) ??
      stringValue(data, ["runId", "agentRunId"]) ??
      null,
    projectId:
      stringValue(run, ["projectId"]) ??
      stringValue(data, ["projectId"]) ??
      stringValue(args, ["projectId"]) ??
      null,
    agentId:
      stringValue(run, ["agentId"]) ??
      stringValue(data, ["agentId"]) ??
      stringValue(args, ["agentId"]) ??
      null,
    agentName:
      stringValue(asRecord(actionPayload?.implementation), ["agentName"]) ??
      stringValue(actionPayload, ["agentName"]) ??
      stringValue(metadata, ["selectedAgentName"]) ??
      null,
    sandboxId:
      stringValue(run, ["sandboxId"]) ??
      stringValue(data, ["sandboxId"]) ??
      stringValue(asRecord(data?.sandbox), ["id"]) ??
      stringValue(asRecord(data?.createdSandbox), ["id"]) ??
      stringValue(args, ["sandboxId"]) ??
      null,
    runtimeId:
      stringValue(run, ["runtimeId"]) ??
      stringValue(data, ["runtimeId"]) ??
      null,
    implementationType:
      stringValue(data, ["implementationType"]) ??
      stringValue(actionPayload, ["implementationType", "type", "kind"]) ??
      stringValue(asRecord(actionPayload?.implementation), ["type", "kind"]) ??
      stringValue(metadata, ["implementationType"]) ??
      (item.action === "profile_run_action" || data?.openPondProfileActionRun === true
        ? "openpond-profile-action"
        : null),
    sourceRef,
    manifestHash:
      stringValue(sourceSummary, ["manifestHash"]) ??
      stringValue(data, ["manifestHash"]) ??
      stringValue(metadata, ["manifestHash"]) ??
      null,
    refs: uniqueActionRunRefs(refs),
    childCalls: actionRunChildCalls(data, run, metadata),
  };
}

function actionNameFromPayload(value: Record<string, unknown> | null): string | null {
  if (!value) return null;
  return (
    stringValue(value, ["actionName", "name"]) ??
    stringValue(asRecord(value.action), ["actionName", "name"]) ??
    stringValue(asRecord(value.actionSummary), ["actionName", "name"]) ??
    stringValue(asRecord(value.selectedEntrypoint), ["name"])
  );
}

function actionRunStatus(
  item: RuntimeEvent,
  responseSummary: Record<string, unknown> | null,
  run: Record<string, unknown> | null,
): ActionRunSummary["status"] {
  if (item.status === "failed") return "failed";
  const responseStatus = stringValue(responseSummary, ["status"]);
  if (responseStatus === "failed") return "failed";
  if (responseStatus === "running" || responseStatus === "pending") {
    return responseStatus;
  }
  if (responseStatus === "available" || item.status === "completed") {
    return "completed";
  }
  const runStatus = stringValue(run, ["status"]);
  if (runStatus === "failed") return "failed";
  if (runStatus === "succeeded" || runStatus === "completed") return "completed";
  if (runStatus === "queued" || runStatus === "running" || runStatus === "runtime_created") {
    return "running";
  }
  if (item.status === "pending") return "pending";
  if (item.status === "started" || item.name === "workspace_action") return "running";
  return "unknown";
}

function actionRunRefs(
  kind: ActionRunRef["kind"],
  value: unknown,
  fallbackLabel: string,
): ActionRunRef[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values.flatMap((item) => {
    const ref = actionRunRef(kind, item, fallbackLabel);
    return ref ? [ref] : [];
  });
}

function actionRunRef(
  kind: ActionRunRef["kind"],
  value: unknown,
  fallbackLabel: string,
): ActionRunRef | null {
  if (typeof value === "string" && value.trim()) {
    const target = value.trim();
    return {
      id: actionRunRefId(kind, target),
      kind,
      label: fallbackLabel,
      target,
    };
  }
  const record = asRecord(value);
  if (!record) return null;
  const target =
    stringValue(record, ["url", "webUrl", "artifactPath", "path", "ref"]) ??
    stringValue(asRecord(record.artifact), ["url", "webUrl", "path", "ref"]);
  if (!target) return null;
  const label =
    stringValue(record, ["label", "title", "name", "type", "kind"]) ??
    fallbackLabel;
  return {
    id: actionRunRefId(kind, target),
    kind,
    label,
    target,
  };
}

function uniqueActionRunRefs(refs: ActionRunRef[]): ActionRunRef[] {
  const seen = new Set<string>();
  const unique: ActionRunRef[] = [];
  for (const ref of refs) {
    const key = `${ref.kind}:${ref.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(ref);
  }
  return unique;
}

function actionRunRefId(kind: ActionRunRef["kind"], target: string): string {
  return `${kind}:${target}`;
}

function actionRunChildCalls(
  data: Record<string, unknown> | null,
  run: Record<string, unknown> | null,
  metadata: Record<string, unknown> | null,
): ActionRunChildCall[] {
  const candidates = [
    data?.childCalls,
    data?.childRuns,
    data?.implementationCalls,
    run?.childCalls,
    run?.childRuns,
    metadata?.childCalls,
    metadata?.childRuns,
  ];
  return candidates.flatMap((value) => childCallsFromValue(value)).slice(0, 6);
}

function childCallsFromValue(value: unknown): ActionRunChildCall[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values.flatMap((item, index) => {
    const record = asRecord(item);
    if (!record) return [];
    const id =
      stringValue(record, ["id", "runId", "callId"]) ??
      `child_${index + 1}`;
    const label =
      stringValue(record, ["label", "title", "actionName", "name", "tool"]) ??
      stringValue(asRecord(record.action), ["label", "name"]) ??
      "Implementation call";
    const detail =
      stringValue(record, ["detail", "summary", "runId", "sandboxId", "runtimeId"]) ??
      null;
    return [
      {
        id,
        label,
        status: childCallStatus(record),
        detail,
      },
    ];
  });
}

function childCallStatus(record: Record<string, unknown>): ActionRunChildCall["status"] {
  const status = stringValue(record, ["status", "state"]);
  if (status === "running" || status === "completed" || status === "failed" || status === "pending") {
    return status;
  }
  if (status === "succeeded") return "completed";
  return "unknown";
}

function titleFromActionName(actionName: string): string {
  const title = actionName.replace(/[._-]+/g, " ").trim();
  return title ? title.replace(/\b\w/g, (letter) => letter.toUpperCase()) : actionName;
}
