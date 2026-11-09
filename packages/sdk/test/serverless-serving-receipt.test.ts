import { expect, it } from "vitest";
import { canonicalSha256 } from "../src/protocol.js";
import { ServerlessServingReviewSchema, createServerlessServingApproval } from "../src/serverless-serving.js";
import { parseAndVerifyTrainingModelServingControl } from "../src/training-model-serving-control.js";

// A valid outer receipt hash must not authenticate tampered nested prices.
it.each(["v1", "v2"] as const)("binds returned %s terms to their accepted review while retaining historical receipts", async (version) => {
  const hash = "a".repeat(64), artifact = {id: "fixture-artifact", contentHash: hash};
  const content = {schemaVersion: `openpond.serverlessServingReview.${version}` as const,
    teamId: "fixture-team", modelProjectId: "fixture-model", versionHash: hash, artifact,
    baseProfileId: "fixture-base", workerImageDigest: `sha256:${hash}`, providerConfigurationHash: hash,
    price: {schemaVersion: "openpond.computeAppliedPrice.v1" as const, service: "model_serving" as const,
      version: "fixture-price", profileHash: hash, currency: "USD" as const, unit: "resource_hour" as const, hourlyUsd: "1.000000"},
    rules: version === "v1" ? {quantity: "allocated_engine_milliseconds" as const, allocation: "equal_billing_principal_then_request" as const,
      startupBillable: false as const, idleBillable: false as const, queueBillable: false as const,
      failure: "observed_engine_work" as const, cancellation: "until_engine_release" as const,
      tokenRetailUsd: "0.000000" as const, minimumBillableMillis: 0 as const} : {
      quantity: "allocated_worker_milliseconds" as const, allocation: "equal_billing_principal_then_request" as const,
      startupBillable: true as const, idleBillable: true as const, cleanupBillable: true as const, queueBillable: false as const,
      failure: "observed_worker_runtime" as const, cancellation: "until_worker_stop" as const,
      tokenRetailUsd: "0.000000" as const, minimumBillableMillis: 0 as const,
      supplierRounding: "ceil_worker_lifetime_second_once" as const},
    workerIdleTimeoutSeconds: 5 as const, maximumRequestMillis: 540000 as const,
    expiresAt: "2000-01-01T00:00:00.000Z"};
  const review = ServerlessServingReviewSchema.parse({...content, contentHash: await canonicalSha256(content)});
  // Old signatures remain readable but cannot mint a new engine-only approval.
  if (version === "v1") {
    const fresh = {...content, expiresAt: "2999-01-01T00:00:00.000Z"};
    await expect(createServerlessServingApproval({...fresh, contentHash: await canonicalSha256(fresh)} as typeof review))
      .rejects.toMatchObject({code: "serverless_serving_review_expired"});
  }
  const request = {schemaVersion: "openpond.trainingModelServingControlRequest.v1" as const,
    teamId: review.teamId, operationId: "fixture-operation", artifact, versionHash: hash,
    expectedRevision: 0, action: "activate" as const, idleTimeoutSeconds: 5,
    serverlessApproval: {schemaVersion: "openpond.serverlessServingApproval.v1" as const,
      reviewHash: review.contentHash, customerCapUsd: "1.000000"}};
  const body = {schemaVersion: "openpond.trainingModelServingControlReceipt.v1" as const,
    teamId: review.teamId, modelProjectId: review.modelProjectId, actorId: "fixture-actor", request,
    control: {schemaVersion: "openpond.trainingModelServingControl.v1" as const,
      teamId: review.teamId, modelProjectId: review.modelProjectId, versionHash: hash, artifact,
      actorId: "fixture-actor", operationId: request.operationId, revision: 1,
      desiredState: "active" as const, phase: "starting" as const, capacityState: "pending" as const,
      modelId: "personalized:model:fixture-model", deploymentId: "fixture-deployment", poolId: "fixture-pool",
      idleTimeoutSeconds: 5, failureCode: null, updatedAt: "2000-01-01T00:00:00.000Z",
      serverless: {schemaVersion: "openpond.serverlessServing.v1" as const, ownerKey: "fixture-owner",
        review, customerCapUsd: "1.000000", state: "active" as const, quantityMicros: 0,
        chargedUsd: "0.000000", reservedUsd: "0.000000", supplierCostStatus: "pending" as const}}};
  const expected = {modelProjectId: review.modelProjectId, request, actorId: body.actorId};
  await expect(parseAndVerifyTrainingModelServingControl({...body, contentHash: await canonicalSha256(body)}, expected)).resolves.toBeDefined();
  // A valid outer hash cannot silently change a retained review's meter terms.
  const changedRules = structuredClone(body);
  changedRules.control.serverless.review.rules.idleBillable = !review.rules.idleBillable;
  await expect(parseAndVerifyTrainingModelServingControl({...changedRules, contentHash: await canonicalSha256(changedRules)}, expected))
    .rejects.toBeDefined();
  const tampered = structuredClone(body);
  tampered.control.serverless.review.price.hourlyUsd = "9.000000";
  await expect(parseAndVerifyTrainingModelServingControl({...tampered, contentHash: await canonicalSha256(tampered)}, expected))
    .rejects.toMatchObject({code: "serverless_serving_review_mismatch"});
});
