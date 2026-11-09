import {
  canonicalJsonByteLength, canonicalSha256, decisionModelIdentity, decisionSupervisedEncoding,
  decisionAdapterConfig, decisionAdapterTensorInventory, decisionArtifactContract,
  parseAndVerifyDecisionModelVersion, resolvedDecisionSelection, parseAndVerifyDecisionModelScoreReceipt,
  type DecisionModelScoreRequest,
} from "openpond-sdk/training";

/** Synthetic protocol metadata only: no files, tensors, optimizer or worker
 * are executed. This peer fixture tests receipt/recovery boundaries and must
 * never be cited as native Decision training or serving qualification. */
export async function decisionScoreFixture() {
  const hash = "b".repeat(64), model = await decisionModelIdentity();
  const training = { learningRate: 0.0001, weightDecay: 0, maxSteps: 1, gradientAccumulationSteps: 1,
    maximumPromptTokens: 512, seed: 0, maxDurationSeconds: 30, maxCheckpointBytes: 268_435_456 };
  const data = { batch: { id: "fixture-batch", revision: 1, contentHash: hash }, examplesSha256: hash,
    encodingHash: await canonicalSha256(await decisionSupervisedEncoding(model, training.maximumPromptTokens)) };
  const request = { schemaVersion: "openpond.decisionTrainingRequest.v1" as const, model, data, training, parentArtifact: null };
  const manifestContent = { schemaVersion: "openpond.decisionAdapterArtifact.v1" as const, method: "decision_model" as const,
    model, adapterConfig: decisionAdapterConfig(), contract: await decisionArtifactContract(model),
    pins: { inputHash: await canonicalSha256(request), recipeHash: await canonicalSha256(training), dataHash: await canonicalSha256(data),
      runtimeHash: hash, parentArtifactHash: null },
    payload: { path: "adapter_model.safetensors" as const, sha256: "c".repeat(64), sizeBytes: 173_188_512, tensors: decisionAdapterTensorInventory() } };
  const manifest = { ...manifestContent, contentHash: await canonicalSha256(manifestContent) };
  const files = [{ path: "adapter_model.safetensors", artifactId: "fixture-artifact", sha256: manifest.payload.sha256, sizeBytes: manifest.payload.sizeBytes }];
  for (const [path, value] of [["manifest.json", manifest], ["adapter_config.json", manifest.adapterConfig], ["decision_contract.json", manifest.contract]] as const)
    files.push({ path, artifactId: "fixture-artifact", sha256: await canonicalSha256(value), sizeBytes: canonicalJsonByteLength(value) });
  const content = { schemaVersion: "openpond.decisionModelVersion.v1" as const, teamId: "team", ownerUserId: "actor",
    modelProjectId: "model", portableProjectId: "portable-model", baseModel: model.source, request,
    source: { executionId: "fixture-execution", inputHash: manifest.pins.inputHash, runtimeHash: hash, resultHash: hash },
    artifact: { id: "fixture-artifact", contentHash: manifest.contentHash, manifest, files }, createdAt: "2026-11-01T00:00:00Z" };
  const version = await parseAndVerifyDecisionModelVersion({ ...content, contentHash: await canonicalSha256(content) });
  const modelId = "managed-decision:" + await canonicalSha256({ schemaVersion: "openpond.desktopDecisionChatSelection.v1",
    teamId: "team", actorId: "actor", apiOrigin: "https://api.example.test", modelProjectId: "model", versionHash: version.contentHash });
  return { version, modelId, async receipt(score: DecisionModelScoreRequest) {
    const scoring = { schemaVersion: "openpond.decisionScoringRequest.v1", model,
      artifact: { id: version.artifact.id, contentHash: version.artifact.contentHash }, input: score.input, limits: score.limits };
    const resultContent = { schemaVersion: "openpond.decisionScoringResult.v1", requestHash: await canonicalSha256(scoring),
      modelHash: await canonicalSha256(model), runtimeHash: hash, preparedRowsHash: hash, artifact: scoring.artifact,
      temperature: 1, distributions: score.input.questions.map(question => ({ questionId: question.id, promptTokenCount: 16,
        candidates: question.choices.map((choice, index) => ({ value: choice.value, code: String.fromCharCode(65 + index),
          tokenId: 100 + index, logit: 0, probability: 1 / question.choices.length })), prediction: question.choices[0]!.value,
        expectedLevel: question.type === "integer_levels" ? question.choices.reduce((sum, choice) => sum + choice.value / question.choices.length, 0) : null })),
      forwardTokenWork: score.input.questions.length * 16, durationMs: 5 };
    const receiptContent = { schemaVersion: "openpond.decisionModelScoreReceipt.v1", teamId: "team", actorId: "actor", modelProjectId: "model",
      requestId: score.requestId, requestHash: await canonicalSha256({ modelProjectId: "model", request: score }),
      version, selection: await resolvedDecisionSelection(version), result: { ...resultContent, contentHash: await canonicalSha256(resultContent) },
      poolId: "pool", routingBinding: { id: "binding", revision: 1 }, runtimeHash: hash, workerImageDigest: `sha256:${"c".repeat(64)}`,
      engineGeneration: 1, cacheNamespace: hash, cleanupComplete: true, completedAt: "2026-11-01T00:01:00Z" };
    return parseAndVerifyDecisionModelScoreReceipt({ ...receiptContent, contentHash: await canonicalSha256(receiptContent) },
      { modelProjectId: "model", request: score, actorId: "actor" });
  } };
}
