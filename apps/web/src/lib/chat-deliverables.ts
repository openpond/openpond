import type { ActivityItem, ChatMessage } from "./app-models";

type ChatArtifact = NonNullable<ActivityItem["artifacts"]>[number];

export function attachTurnDeliverables(messages: ChatMessage[]): void {
  const finalResponseByTurnId = new Map<string, string>();
  const settledTurnIds = new Set<string>();
  for (const message of messages) {
    if (!message.turnId) continue;
    if (message.role === "assistant" && message.content?.trim()) {
      finalResponseByTurnId.set(message.turnId, message.content);
    }
    if (
      message.role === "error" ||
      (message.role === "status_divider" && message.statusState !== "running") ||
      (message.role === "activity_group" && message.traceState !== "running")
    ) {
      settledTurnIds.add(message.turnId);
    }
  }

  for (const message of messages) {
    if (message.role !== "activity_group" || !message.turnId) continue;
    if (message.activities?.some((activity) => activity.subagentMessage)) continue;
    const candidates = nonInspectionArtifacts(message.activities ?? []);
    if (candidates.length === 0) {
      message.deliverables = undefined;
      continue;
    }
    const finalResponse = finalResponseByTurnId.get(message.turnId) ?? "";
    const referenced = finalResponse ? artifactsReferencedByText(candidates, finalResponse) : [];
    if (referenced.length > 0) {
      message.deliverables = referenced;
      continue;
    }
    message.deliverables = !settledTurnIds.has(message.turnId)
      ? undefined
      : [candidates[candidates.length - 1]!];
  }
}

export function selectTurnDeliverables(input: {
  activities: ActivityItem[];
  finalResponse?: string | null;
  settled: boolean;
}): ChatArtifact[] {
  const candidates = nonInspectionArtifacts(input.activities);
  if (candidates.length === 0) return [];
  const referenced = input.finalResponse
    ? artifactsReferencedByText(candidates, input.finalResponse)
    : [];
  if (referenced.length > 0) return referenced;
  return input.settled ? [candidates[candidates.length - 1]!] : [];
}

function nonInspectionArtifacts(activities: ActivityItem[]): ChatArtifact[] {
  const inspectedPaths = new Set(
    activities
      .map((activity) => activity.imagePreview?.path)
      .filter((path): path is string => Boolean(path)),
  );
  const candidates = new Map<string, ChatArtifact>();
  for (const activity of activities) {
    if (activity.imagePreview) continue;
    for (const artifact of activity.artifacts ?? []) {
      if (inspectedPaths.has(artifact.path)) continue;
      candidates.delete(artifact.path);
      candidates.set(artifact.path, artifact);
    }
  }
  return [...candidates.values()];
}

function artifactsReferencedByText(artifacts: ChatArtifact[], text: string): ChatArtifact[] {
  const decodedText = decodeUriComponent(text);
  return artifacts.filter((artifact) => artifactReferenceVariants(artifact).some(
    (reference) => text.includes(reference) || decodedText.includes(reference),
  ));
}

function artifactReferenceVariants(artifact: ChatArtifact): string[] {
  const references = new Set<string>();
  for (const value of [artifact.path, artifact.title, fileName(artifact.path)]) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    references.add(trimmed);
    references.add(decodeUriComponent(trimmed));
  }
  return [...references];
}

function fileName(value: string): string {
  return value.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? value;
}

function decodeUriComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
