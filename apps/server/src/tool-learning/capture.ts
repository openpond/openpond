import { realpath } from "node:fs/promises";
import type { z } from "zod";
import { contentHash } from "@openpond/harness";
import { assertBoundedTaskJson } from "@openpond/evals/task-schema";
import {
  sealToolEpisodeEvent,
  ToolLearningEnvironmentSchema,
  ToolLearningActionSchema,
  type ToolEpisodeEvent,
} from "openpond-sdk/tool-learning";
import { ToolLearningLocalStore } from "openpond-sdk/tool-learning/node";
import { scanAndRedactEvidence } from "openpond-sdk/training-bundle";
import { loadToolLearningCredential } from "./local.js";
import { configureLocalToolLearning, flushToolLearning } from "./delivery.js";

export type ToolLearningBoundary = {
  client: "claude_code" | "openpond";
  workspaceRoot: string;
  installationId?: string;
  accountScope?: {
    apiOrigin: string;
    accountHandle: string | null;
    ownerUserId: string;
    teamId?: string | null;
  };
  sessionId: string;
  parentSessionId?: string | null;
  turnId?: string | null;
  callId: string;
  tool: string;
  clientVersion: string;
  phase: "attempt" | "observation";
  arguments?: unknown;
  invalidArguments?: string;
  intent?: string;
  environment?: z.infer<typeof ToolLearningEnvironmentSchema>;
  result?: {
    outcome: "succeeded" | "failed" | "incomplete";
    execution: "executed" | "not_executed" | "unknown";
    sideEffects: "none" | "possible" | "observed" | "unknown";
    text: string;
    classification?:
      | "validation_failure"
      | "execution_failure"
      | "process_failure"
      | "timeout"
      | "cancelled"
      | "infrastructure_failure"
      | "authorization_denied"
      | "outcome_failure"
      | "unknown_failure";
    exitCode?: number | null;
  };
};

function boundedExcerpt(text: string, maximum: number) {
  const bytes = Buffer.from(text);
  let end = Math.min(bytes.length, maximum);
  while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

function privatePayload(value: unknown) {
  try {
    assertBoundedTaskJson(value, 32768);
  } catch {
    return true;
  }
  const text = JSON.stringify(value);
  // File exclusion is a collection boundary. It does not decide whether an
  // action should execute or which specialist the main agent should invoke.
  if (/(?:^|[\s/\\'"=])\.env(?:[.\s/\\'";]|$)/u.test(text)) return true;
  const scan = scanAndRedactEvidence(text);
  return scan.secretStatus !== "passed" || scan.piiStatus !== "passed";
}

/** Observe only. This function never executes, retries or changes a user tool.
 * Cross-process correlation is bounded and sanitized before any persistence. */
export async function captureLocalToolBoundary(home: string, input: ToolLearningBoundary) {
  const root = await realpath(input.workspaceRoot);
  const store = new ToolLearningLocalStore(home);
  const captured: Array<{ installationId: string; event: ToolEpisodeEvent }> = [];
  const deliverySignal = AbortSignal.timeout(2000);
  try {
    const installations = store
      .installations()
      .filter(
        (item) =>
          item.enabled &&
          item.client === input.client &&
          item.workspaceRoot === root &&
          (!input.installationId || item.id === input.installationId) &&
          item.policy.permittedTools.includes(input.tool),
      );
    for (const installation of installations) {
      const saved = await loadToolLearningCredential(home, installation.id),
        record = saved.value;
      if (
        !record.locallyEnabled ||
        record.prepared.registration.clientVersion !== input.clientVersion ||
        record.workspaceRoot !== root ||
        record.installation?.state !== "enabled"
      )
        continue;
      if (
        input.accountScope &&
        (record.apiOrigin !== input.accountScope.apiOrigin ||
          record.ownerAccount !== input.accountScope.accountHandle ||
          record.installation.ownerUserId !== input.accountScope.ownerUserId ||
          (input.accountScope.teamId && input.accountScope.teamId !== record.teamId))
      )
        continue;
      configureLocalToolLearning(store, record, record.installation);
      const policy = installation.policy,
        policyHash = contentHash(policy);
      if (
        !policy.purposes.includes("capture") ||
        !policy.workspaceRootHashes.includes(contentHash(root))
      )
        continue;
      const permits = (field: (typeof policy.permittedFields)[number]) =>
        policy.permittedFields.includes(field);
      const boundaryId = `tool-boundary-${contentHash([installation.id, input.sessionId, input.callId, input.phase])}`;
      const base = {
        schemaVersion: "openpond.toolEpisodeEvent.v1",
        operationId: boundaryId,
        installationId: installation.id,
        episodeId: `tool-episode-${contentHash([installation.id, input.sessionId, input.callId])}`,
        eventId: boundaryId,
        sessionId: input.sessionId,
        parentSessionId: input.parentSessionId ?? null,
        turnId: input.turnId ?? null,
        callId: input.callId,
        occurredAt: new Date().toISOString(),
        sequence: input.phase === "attempt" ? 0 : 1,
        adapterVersion: record.prepared.registration.adapterRelease.id,
        sanitization: {
          policyRevision: policy.revision,
          policyHash,
          redactedFields: 0,
          omittedFields: 0,
          truncated: false,
        },
      };
      if (input.phase === "attempt") {
        if (!permits("action")) continue;
        const proposedAction =
          input.invalidArguments === undefined
            ? { kind: "tool_arguments", arguments: input.arguments }
            : { kind: "tool_arguments", arguments: { invalidArguments: input.invalidArguments } };
        const checkedAction = ToolLearningActionSchema.safeParse(proposedAction);
        if (!checkedAction.success) {
          store.recordDropped(installation.id);
          continue;
        }
        const action = checkedAction.data;
        const suppliedEnvironment = input.environment ??
          record.environment ?? {
            application: input.tool,
            version: input.clientVersion,
            state: { workspaceRootHash: contentHash(root) },
            fingerprint: contentHash([input.tool, input.clientVersion, root]),
          };
        const environment = ToolLearningEnvironmentSchema.parse(
          permits("state") ? suppliedEnvironment : { ...suppliedEnvironment, state: {} },
        );
        const payload = {
          intent: permits("intent") ? (input.intent ?? "") : "",
          tool: { name: input.tool, version: input.clientVersion, server: null },
          action,
          actionHash: contentHash(action),
          environment,
          contextAssets: [],
          selection: { kind: "eligible_attempt" },
        };
        if (privatePayload(payload)) {
          store.recordDropped(installation.id);
          continue;
        }
        const attempt = store.retainCaptureBoundary(
          sealToolEpisodeEvent({ ...base, eventKind: "attempt", payload }),
        );
        if (attempt) captured.push({ installationId: installation.id, event: attempt });
        continue;
      }
      const attempt = store.captureBoundary(
        installation.id,
        input.sessionId,
        input.callId,
        "attempt",
      );
      if (!attempt || attempt.eventKind !== "attempt" || !input.result) continue;
      // Sample ordinary success controls by immutable call identity. Retain a
      // bounded follow-up window after failure for explicit owner selection;
      // never infer that a later successful call verified the original task.
      const sample = policy.unchangedControls;
      const selected =
        input.result.outcome !== "succeeded" ||
        store.hasRecoveryCandidateContext(installation.id, input.sessionId) ||
        parseInt(contentHash([installation.id, input.sessionId, input.callId]).slice(0, 8), 16) /
          4294967296 <
          sample.numerator / sample.denominator;
      if (!selected) continue;
      if (!input.result.text || Buffer.byteLength(input.result.text) > 8192) {
        if (Buffer.byteLength(input.result.text) > 8192) {
          store.recordDropped(installation.id);
          continue;
        }
      }
      const common = {
        attempt: { id: attempt.eventId, contentHash: attempt.contentHash },
        actionHash: attempt.payload.actionHash,
        execution: input.result.execution,
        sideEffects: input.result.sideEffects,
        resultExcerpt: permits("result_excerpt") ? input.result.text : "",
        resultHash: permits("result_excerpt") ? contentHash(input.result.text) : null,
        assets: [],
      };
      const payload =
        input.result.outcome === "succeeded"
          ? { ...common, outcome: "succeeded", exitCode: input.result.exitCode ?? null }
          : input.result.outcome === "incomplete"
            ? { ...common, outcome: "incomplete", reason: "completion_not_observed" }
            : {
                ...common,
                outcome: "failed",
                classification: input.result.classification ?? "unknown_failure",
                errorCode: input.result.classification ?? "unknown_failure",
                message: permits("result_excerpt") ? boundedExcerpt(input.result.text, 2000) : "",
                exitCode: input.result.exitCode ?? null,
              };
      if (privatePayload(payload)) {
        store.recordDropped(installation.id);
        continue;
      }
      const observation = store.retainCaptureBoundary(
        sealToolEpisodeEvent({
          ...base,
          episodeId: attempt.episodeId,
          eventKind: "observation",
          payload,
        }),
      );
      if (!observation) continue;
      store.append(attempt);
      store.append(observation);
      captured.push({ installationId: installation.id, event: observation });
      // Delayed delivery is allowed; a transport failure retains exact queue
      // bytes. A later explicit flush or lifecycle hook delivers them.
      try {
        await flushToolLearning(home, store, record, deliverySignal);
      } catch {
        /* Status retains backlog; no user action is repeated. */
      }
    }
    return captured.map((item) => ({
      installationId: item.installationId,
      eventId: item.event.eventId,
      contentHash: item.event.contentHash,
    }));
  } finally {
    store.close();
  }
}
