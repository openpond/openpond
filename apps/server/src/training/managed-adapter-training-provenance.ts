import {
  createHash,
  createPrivateKey,
  sign,
} from "node:crypto";

export const OPENPOND_TRAINING_PROVENANCE_KEY_ID_ENV =
  "OPENPOND_TRAINING_PROVENANCE_KEY_ID";
export const OPENPOND_TRAINING_PROVENANCE_PRIVATE_KEY_PEM_ENV =
  "OPENPOND_TRAINING_PROVENANCE_PRIVATE_KEY_PEM";

export type OpenPondTrainingProvenancePayload = {
  schemaVersion: "openpond.modelAdapterSourceProvenance.v1";
  sourceSystem: "openpond_training";
  trainingJobId: string;
  trainingPlanId: string;
  sourceArtifactId: string;
  sourceArtifactSha256: string;
  sourceManifestSha256: string;
  sourceInventorySha256: string;
  sourceBaseModelSha256: string;
  candidateBundleSha256?: string;
  tasksetId: string;
  tasksetHash: string;
  evaluationArtifactId?: string;
  evaluationArtifactSha256?: string;
  frozenEvaluatorHash?: string;
  spendAttestationSha256: string;
  cleanupAttestationSha256: string;
  providerRunId: string;
  trainingMethod: "grpo";
  sourcePolicyOrCheckpoint: string;
  optimizerProofSha256: string;
  modelProjectId: string;
  modelRunId: string;
  modelVersionId: string;
  primeRlRevision: string;
  rawPrimeComputeReceiptSha256: string;
  harnessReleaseSha256: string;
  profileReleaseSha256: string;
  agentReleaseSha256: string;
  graderSha256: string;
  trainingTelemetrySha256: string;
};

export type SignedOpenPondTrainingProvenance =
  OpenPondTrainingProvenancePayload & {
    signedPayloadSha256: string;
    signature: {
      algorithm: "ed25519";
      keyId: string;
      value: string;
    };
  };

export function signOpenPondTrainingProvenance(
  payload: OpenPondTrainingProvenancePayload,
  environment: NodeJS.ProcessEnv = process.env,
): SignedOpenPondTrainingProvenance {
  if (
    environment.OPENPOND_MODEL_ADAPTER_CONTROL_RUNTIME?.trim()
    !== "trusted-hosted"
  ) {
    throw new Error(
      "OpenPond training provenance may be signed only in the trusted hosted bridge runtime.",
    );
  }
  const keyId =
    environment[OPENPOND_TRAINING_PROVENANCE_KEY_ID_ENV]?.trim();
  const privateKeyPem =
    environment[
      OPENPOND_TRAINING_PROVENANCE_PRIVATE_KEY_PEM_ENV
    ]
      ?.replaceAll("\\n", "\n")
      .trim();
  if (!keyId || !privateKeyPem) {
    throw new Error(
      `${OPENPOND_TRAINING_PROVENANCE_KEY_ID_ENV} and ${OPENPOND_TRAINING_PROVENANCE_PRIVATE_KEY_PEM_ENV} are required for trusted OpenPond training publication.`,
    );
  }
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error(
      "OpenPond training provenance requires an Ed25519 private key.",
    );
  }
  const bytes = Buffer.from(compactCanonicalJson(payload), "utf8");
  return {
    ...payload,
    signedPayloadSha256: createHash("sha256")
      .update(bytes)
      .digest("hex"),
    signature: {
      algorithm: "ed25519",
      keyId,
      value: sign(null, bytes, privateKey).toString("base64"),
    },
  };
}

export function compactCanonicalJson(value: unknown): string {
  return JSON.stringify(compactCanonicalValue(value));
}

function compactCanonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(compactCanonicalValue);
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [
        key,
        compactCanonicalValue(child),
      ]),
  );
}
