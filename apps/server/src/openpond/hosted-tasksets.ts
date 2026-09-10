import { createHash } from "node:crypto";

import type { ChatProvider, Session } from "@openpond/contracts";

import type { OpenPondDatasetBuilderAction } from "./dataset-builder-tool-definitions.js";
import { requestOpenPondPublicApi } from "./sandboxes.js";

type HostedTasksetRequest = typeof requestOpenPondPublicApi;

export async function executeHostedTasksetAction(input: {
  session: Session;
  provider: ChatProvider;
  model: string;
  action: OpenPondDatasetBuilderAction;
  payload: Record<string, unknown>;
  request?: HostedTasksetRequest;
}): Promise<Record<string, unknown>> {
  const conversationId = stringValue(input.session.metadata?.hostConversationId);
  const sandboxId = stringValue(input.session.metadata?.hostSandboxId);
  if (
    input.session.workspaceKind !== "sandbox" ||
    !sandboxId ||
    input.session.workspaceId !== sandboxId ||
    !conversationId
  ) {
    throw new Error("Hosted Taskset actions require the bound Work workspace.");
  }
  if (input.action === "answer_questions") {
    throw new Error(
      "Hosted Taskset authoring has no separate question queue. Revise with the complete buildSpecification.",
    );
  }
  if (input.action === "revise" && !input.payload.buildSpecification) {
    throw new Error(
      "Hosted Taskset revisions require the complete buildSpecification.",
    );
  }
  const sourceReferenceIds = stringArray(
    input.payload.sourceReferenceIds ?? input.payload.sourceIds,
  );
  const body = compact({
    action: input.action,
    clientRequestId: actionRequestId(input),
    creationId: input.payload.creationId,
    tasksetId: input.payload.tasksetId,
    objective: input.payload.objective,
    buildIntent: input.payload.buildIntent,
    buildSpecification: input.payload.buildSpecification,
    sourceReferenceIds,
    methodHint: input.payload.methodHint,
    approved: input.payload.approved,
    split: input.payload.split,
    taskLimit: input.payload.taskLimit,
    attemptsPerTask: input.payload.attemptsPerTask,
    message: input.payload.message,
    answers: input.payload.answers,
  });
  return (input.request ?? requestOpenPondPublicApi)({
    path: "/hosted-tasksets/actions",
    method: "POST",
    body,
  });
}

function actionRequestId(input: {
  session: Session;
  provider: ChatProvider;
  model: string;
  action: OpenPondDatasetBuilderAction;
  payload: Record<string, unknown>;
}): string {
  const digest = createHash("sha256")
    .update(
      stableStringify({
        sessionId: input.session.id,
        provider: input.provider,
        model: input.model,
        action: input.action,
        payload: input.payload,
      }),
    )
    .digest("hex")
    .slice(0, 32);
  return `${input.session.id}:${digest}`.slice(0, 191);
}

function compact(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  );
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}
