import { contentHash } from "@openpond/harness";
import { z } from "zod";
import { ToolLearningLocalStore } from "openpond-sdk/tool-learning/node";
import {
  ToolLearningConsultationRequestSchema,
  OpenPondToolLearningError,
} from "openpond-sdk/tool-learning";
import { scanAndRedactEvidence } from "openpond-sdk/training-bundle";
import { loadToolLearningCredential, toolLearningProducer } from "./local.js";
import { configureLocalToolLearning, flushToolLearning } from "./delivery.js";

export const LocalToolConsultInput = z
  .object({
    sessionId: z.string().min(1).max(200),
    failedCallId: z.string().min(1).max(200),
    capabilityId: z.string().min(1).max(200),
    intent: z.string().max(2000),
  })
  .strict();
export async function consultLocalToolLearning(
  home: string,
  installationId: string,
  value: unknown,
  signal?: AbortSignal,
) {
  const input = LocalToolConsultInput.parse(value),
    { value: record } = await loadToolLearningCredential(home, installationId);
  if (!record.locallyEnabled || record.installation?.state !== "enabled")
    throw new Error("tool_learning_consultation_disabled");
  const store = new ToolLearningLocalStore(home);
  try {
    configureLocalToolLearning(store, record, record.installation);
    const attempt = store.captureBoundary(
      installationId,
      input.sessionId,
      input.failedCallId,
      "attempt",
    );
    const observation = store.captureBoundary(
      installationId,
      input.sessionId,
      input.failedCallId,
      "observation",
    );
    if (
      !attempt ||
      attempt.eventKind !== "attempt" ||
      !observation ||
      observation.eventKind !== "observation" ||
      observation.payload.outcome !== "failed"
    )
      throw new Error("tool_learning_observed_failure_required");
    const privacy = scanAndRedactEvidence(input.intent);
    if (privacy.secretStatus !== "passed" || privacy.piiStatus !== "passed")
      throw new Error("tool_learning_consultation_privacy_blocked");
    const client = toolLearningProducer(record);
    const failure = {
      message: observation.payload.message,
      observation: { id: observation.eventId, contentHash: observation.contentHash },
    };
    const contextHash = contentHash({
      intent: input.intent,
      environment: attempt.payload.environment,
      failure,
    });
    const previous = store.consultationForCall(installationId, input.sessionId, input.failedCallId);
    if (previous) {
      const operationId = previous.operationId;
      if (previous.contextHash !== contextHash || previous.capabilityId !== input.capabilityId)
        return {
          operationId,
          response: { state: "unavailable", reason: "failure_already_submitted" },
          recovery:
            "Read the original consultation with openpond_consult_status. Changing context or capability does not authorize another paid call.",
        };
      try {
        return { operationId, response: await client.consultation(previous, signal) };
      } catch (error) {
        if (
          !(error instanceof OpenPondToolLearningError) ||
          error.status !== 404 ||
          error.code !== "tool_learning_consultation_not_found"
        )
          throw error;
        return { operationId, response: await client.consult(previous, signal) };
      }
    }
    const manifest = await client.manifest(installationId, signal);
    const capability = manifest.capabilities.find((c) => c.id === input.capabilityId);
    if (
      !capability ||
      capability.application !== attempt.payload.environment.application ||
      !capability.versions.includes(attempt.payload.environment.version) ||
      !capability.tools.includes(attempt.payload.tool.name)
    )
      throw new Error("tool_learning_consultation_scope_unsupported");
    const operationId = `tool-consult-${contentHash([installationId, input.sessionId, input.failedCallId, input.capabilityId, attempt.payload.actionHash, contextHash, manifest.modelRelease])}`;
    const request = ToolLearningConsultationRequestSchema.parse({
      schemaVersion: "openpond.toolLearningConsultation.v1",
      operationId,
      installationId,
      scope: manifest.scope,
      sessionId: input.sessionId,
      callId: input.failedCallId,
      capabilityId: input.capabilityId,
      manifestHash: manifest.contentHash,
      modelRelease: manifest.modelRelease,
      mode: "recovery",
      intent: input.intent,
      action: attempt.payload.action,
      actionHash: attempt.payload.actionHash,
      environment: attempt.payload.environment,
      contextHash,
      failure,
      round: 1,
    });
    store.retainConsultationRequest(request);
    await flushToolLearning(home, store, record, signal);
    try {
      return { operationId, response: await client.consult(request, signal) };
    } catch {
      return {
        operationId,
        response: { state: "unavailable", reason: "dispatch_uncertain" },
        recovery:
          "Use openpond_consult_status with this operationId; do not create a replacement request.",
      };
    }
  } finally {
    store.close();
  }
}
export async function readLocalToolConsultation(
  home: string,
  installationId: string,
  operationId: string,
  signal?: AbortSignal,
) {
  const { value: record } = await loadToolLearningCredential(home, installationId);
  if (!record.locallyEnabled) throw new Error("tool_learning_consultation_disabled");
  const store = new ToolLearningLocalStore(home);
  try {
    const request = store.consultationRequest(installationId, operationId);
    if (!request) throw new Error("tool_learning_consultation_request_not_retained");
    return {
      operationId,
      response: await toolLearningProducer(record).consultation(request, signal),
    };
  } finally {
    store.close();
  }
}
