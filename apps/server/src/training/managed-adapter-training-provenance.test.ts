import {
  createHash,
  generateKeyPairSync,
  verify,
} from "node:crypto";

import { describe, expect, test } from "vitest";

import {
  compactCanonicalJson,
  signOpenPondTrainingProvenance,
  type OpenPondTrainingProvenancePayload,
} from "./managed-adapter-training-provenance.js";

describe("OpenPond training provenance signer", () => {
  test("signs the exact compact canonical payload only in the hosted control boundary", () => {
    const keyPair = generateKeyPairSync("ed25519");
    const provenance = signOpenPondTrainingProvenance(
      provenancePayload(),
      {
        OPENPOND_MODEL_ADAPTER_CONTROL_RUNTIME:
          "trusted-hosted",
        OPENPOND_TRAINING_PROVENANCE_KEY_ID: "key-2026-07",
        OPENPOND_TRAINING_PROVENANCE_PRIVATE_KEY_PEM:
          keyPair.privateKey.export({
            type: "pkcs8",
            format: "pem",
          }).toString(),
      },
    );
    const { signature, signedPayloadSha256, ...payload } =
      provenance;
    const bytes = Buffer.from(
      compactCanonicalJson(payload),
      "utf8",
    );

    expect(signedPayloadSha256).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(signature).toMatchObject({
      algorithm: "ed25519",
      keyId: "key-2026-07",
    });
    expect(
      verify(
        null,
        bytes,
        keyPair.publicKey,
        Buffer.from(signature.value, "base64"),
      ),
    ).toBe(true);
  });

  test("fails closed outside the trusted hosted control runtime", () => {
    expect(() =>
      signOpenPondTrainingProvenance(
        provenancePayload(),
        {},
      )
    ).toThrow("trusted hosted bridge runtime");
  });
});

function provenancePayload(): OpenPondTrainingProvenancePayload {
  const hash = (character: string) => character.repeat(64);
  return {
    schemaVersion:
      "openpond.modelAdapterSourceProvenance.v1",
    sourceSystem: "openpond_training",
    trainingJobId: "job-1",
    trainingPlanId: "plan-1",
    sourceArtifactId: "artifact-1",
    sourceArtifactSha256: hash("1"),
    sourceManifestSha256: hash("2"),
    sourceInventorySha256: hash("3"),
    sourceBaseModelSha256: hash("4"),
    candidateBundleSha256: hash("5"),
    tasksetId: "taskset-1",
    tasksetHash: hash("6"),
    evaluationArtifactId: "evaluation-1",
    evaluationArtifactSha256: hash("7"),
    frozenEvaluatorHash: hash("8"),
    spendAttestationSha256: hash("9"),
    cleanupAttestationSha256: hash("a"),
    providerRunId: "prime-run-1",
    trainingMethod: "grpo",
    sourcePolicyOrCheckpoint: "model-version-1:policy-1",
    optimizerProofSha256: hash("b"),
    modelProjectId: "model-1",
    modelRunId: "model-run-1",
    modelVersionId: "model-version-1",
    primeRlRevision: "c".repeat(40),
    rawPrimeComputeReceiptSha256: hash("d"),
    harnessReleaseSha256: hash("e"),
    profileReleaseSha256: hash("f"),
    agentReleaseSha256: hash("0"),
    graderSha256: hash("1"),
    trainingTelemetrySha256: hash("2"),
  };
}
