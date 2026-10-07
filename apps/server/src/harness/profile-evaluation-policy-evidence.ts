import { contentHash } from "@openpond/harness";
import {
  ProfileEvaluationEvidenceRefSchema,
  type AttemptReceipt,
  type TasksetRunManifest,
} from "@openpond/evals";
import {
  FileOutputRefSchema,
  type OpenPondProfileRef,
  type RuntimeEvent,
  type Turn,
} from "@openpond/contracts";
import type { HarnessStateStore } from "../store/harness-state-store.js";

type EvidenceStore = Pick<
  HarnessStateStore,
  "getSession" | "getTurn" | "runtimeEventsForTurn" | "listModelUsageRecords"
>;

export function profileEvaluationOutput(
  events: RuntimeEvent[],
  targetKind: string,
  status: Turn["status"],
): string {
  if (targetKind === "agent_action") {
    const result = events.find(
      (event) =>
        event.name === "workspace_action_result" &&
        event.action === "profile_workflow_action",
    )?.output;
    if (typeof result !== "string")
      throw new Error(
        "Profile Agent action evaluation did not produce a released action result.",
      );
    return result;
  }
  if (status === "completed") {
    const terminal = [...events].reverse().find(event => event.name === "turn.completed");
    const marker = terminal?.data as { providerResponse?: { requestId?: unknown; contentHash?: unknown } } | undefined;
    const response = marker?.providerResponse;
    if (typeof response?.requestId !== "string" || !response.requestId
      || typeof response.contentHash !== "string")
      throw new Error("Profile evaluation has no retained final provider response.");
    const text = events.filter(event => event.name === "assistant.delta"
      && (event.data as { providerRequestId?: unknown } | undefined)?.providerRequestId === response.requestId)
      .map(event => event.output ?? "").join("");
    if (contentHash(text) !== response.contentHash)
      throw new Error("Profile evaluation final provider response differs from its retained trace.");
    return text;
  }
  // Failed/interrupted turns retain partial text for inspection, never as a
  // completed response. Progress and truncated rounds remain in the full trace.
  return events
    .filter(
      (event) =>
        event.name === "assistant.delta" && typeof event.output === "string",
    )
    .map((event) => event.output ?? "")
    .join("");
}

/** Resolve a receipt's exact policy turn through the already authorized store.
 * Neither a caller-provided turn nor a newer source can supply old evidence. */
export async function readProfileEvaluationPolicyEvidence(input: {
  store: EvidenceStore;
  profileRef: OpenPondProfileRef;
  manifest: TasksetRunManifest;
  receipt: AttemptReceipt;
  eventAfterId?: string;
  eventLimit?: number;
}) {
  const { store, manifest, receipt } = input;
  if (!receipt.metadata.retainedEvidenceRef) return null;
  const ref = ProfileEvaluationEvidenceRefSchema.parse(
    receipt.metadata.retainedEvidenceRef,
  );
  const [session, turn] = await Promise.all([
    store.getSession(ref.sessionId),
    store.getTurn(ref.turnId),
  ]);
  const binding = session?.metadata?.profileEvaluationRun;
  const source = manifest.profileEvaluation;
  if (
    !session ||
    !turn ||
    turn.sessionId !== session.id ||
    !source ||
    !session.currentProfile ||
    contentHash(session.currentProfile) !== contentHash(input.profileRef) ||
    contentHash(binding) !==
      contentHash({ id: manifest.id, contentHash: manifest.contentHash }) ||
    session.metadata?.taskId !== receipt.taskId ||
    session.metadata?.seed !== receipt.seed ||
    !turn.completedAt ||
    turn.completedAt !== receipt.completedAt ||
    turn.startedAt !== receipt.startedAt ||
    !turn.harnessSnapshot ||
    turn.harnessSnapshot.harnessRelease.id !== source.harnessRelease.id ||
    turn.harnessSnapshot.harnessRelease.contentHash !==
      source.harnessRelease.contentHash ||
    manifest.policy.kind !== "model" ||
    !turn.modelRef ||
    turn.modelRef.providerId !== manifest.policy.model.provider ||
    turn.modelRef.modelId !== manifest.policy.model.model
  ) {
    throw new Error(
      "Retained Profile policy turn differs from its admitted case.",
    );
  }
  const events = await store.runtimeEventsForTurn(turn.id);
  if (
    events.some((event) => event.turnId !== turn.id) ||
    contentHash(events) !== receipt.traceHash
  ) {
    throw new Error(
      "Retained Profile policy trace differs from its immutable receipt.",
    );
  }
  const text = profileEvaluationOutput(events, source.target.kind, turn.status);
  if (
    receipt.outputHash !== null &&
    contentHash({ text }) !== receipt.outputHash
  ) {
    throw new Error(
      "Retained Profile output differs from its immutable receipt.",
    );
  }
  const files = receipt.artifactRefs.flatMap((ref) => {
    const matches = events
      .filter(
        (event) =>
          (event.action === "work_output_save" ||
            event.action === "sandbox_save_output") &&
          event.status === "completed",
      )
      .flatMap((event) => {
        const value =
          event.data && typeof event.data === "object"
            ? (event.data as Record<string, unknown>)
            : {};
        const parsed = FileOutputRefSchema.safeParse(value.outputRef);
        return parsed.success ? [parsed.data] : [];
      })
      .filter(
        (file) =>
          file.sourceTaskId === session.id &&
          file.sourceTurnId === turn.id &&
          `${session.id}/${file.id}/${file.revision}/${file.title}` ===
            ref.id &&
          file.sha256 === ref.contentHash &&
          file.sizeBytes === ref.sizeBytes &&
          file.contentType === ref.mediaType,
      );
    if (matches.length !== 1)
      throw new Error(
        "The case output has no unique sealed saved-file identity.",
      );
    const file = matches[0]!;
    if (file.location.kind !== "managed") return [];
    const downloadPath = `/api/work/outputs/${encodeURIComponent(file.location.fileId)}`;
    if (file.location.downloadPath !== downloadPath)
      throw new Error(
        "The saved output has no canonical managed download route.",
      );
    return [
      {
        id: file.id,
        title: file.title,
        revision: file.revision,
        contentType: file.contentType,
        sizeBytes: file.sizeBytes,
        sha256: file.sha256,
        downloadPath,
      },
    ];
  });
  const usage = await store.listModelUsageRecords({
    sessionId: session.id,
    turnId: turn.id,
    limit: 10_000,
  });
  const afterIndex = input.eventAfterId
    ? events.findIndex((event) => event.id === input.eventAfterId)
    : -1;
  if (input.eventAfterId && afterIndex < 0)
    throw new Error("Profile trace cursor is unavailable in this case.");
  const start = afterIndex + 1;
  const limit = Math.max(1, Math.min(250, input.eventLimit ?? 100));
  const page = events.slice(start, start + limit);
  return {
    ref,
    prompt: turn.prompt,
    output: receipt.outputHash === null ? null : { text },
    partialOutput: receipt.outputHash === null && text ? { text } : null,
    error: turn.error,
    events: page,
    eventCount: events.length,
    nextEventCursor:
      start + page.length < events.length ? page.at(-1)!.id : null,
    files,
    usage,
    usageCoverage: usage.length === 10_000 ? "partial" : "complete",
  };
}
