import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ManagedAdapterServingProjectionSchema,
  managedAdapterEvaluationPassed,
  type ModelArtifactLineage,
} from "@openpond/contracts";
import { describe, expect, test, vi } from "vitest";

import {
  ManagedAdapterEvaluationPanel,
  ManagedAdapterServingEvidence,
  downloadCanonicalJson,
} from "../apps/web/src/components/labs/ManagedAdapterServingEvidence";

describe("managed adapter serving evidence", () => {
  test("keeps admission passed and the serving receipt visible after GPU cleanup", () => {
    const projection = servingProjection();
    const markup = renderToStaticMarkup(
      createElement(ManagedAdapterServingEvidence, { projection }),
    );

    expect(markup).toContain("Managed Sandbox serving");
    expect(markup).toContain("Offline · proof retained");
    expect(markup).toContain("Sandbox admission");
    expect(markup).toContain(">Passed<");
    expect(markup).toContain("lora_71b204631fe45791697ba622");
    expect(markup).toContain("Warm hit");
    expect(markup).toContain("1907491939");
    expect(markup).toContain("49.9 ms");
    expect(markup).toContain("estimated");
    expect(markup).toContain("Evaluation receipt");
    expect(markup).toContain("Serving receipt");
    expect(markup).toContain("Full projection");
  });

  test("labels the Sandbox receipt as admission evidence, not a quality benchmark", () => {
    const evaluation = servingProjection().evaluation!;
    const markup = renderToStaticMarkup(
      createElement(ManagedAdapterEvaluationPanel, { evaluation }),
    );

    expect(markup).toContain("Sandbox compatibility and admission receipt");
    expect(markup).toContain("independent from the product-quality benchmark");
    expect(markup).toContain("Candidate diagnostic");
    expect(markup).toContain("0.3333");
  });

  test("does not erase completed Sandbox evaluation when deployment is offline", () => {
    const projection = servingProjection();
    const lineage = {
      managedServing: projection,
    } as ModelArtifactLineage;

    expect(managedAdapterEvaluationPassed(lineage)).toBe(true);
  });

  test("downloads the canonical JSON receipt with a stable filename", async () => {
    const click = vi.fn();
    const remove = vi.fn();
    const append = vi.fn();
    const revokeObjectURL = vi.fn();
    let downloadedBlob: Blob | null = null;
    const anchor = {
      click,
      download: "",
      hidden: false,
      href: "",
      remove,
    };
    vi.stubGlobal("document", {
      body: { append },
      createElement: () => anchor,
    });
    vi.stubGlobal("URL", {
      createObjectURL: (blob: Blob) => {
        downloadedBlob = blob;
        return "blob:serving-receipt";
      },
      revokeObjectURL,
    });
    vi.stubGlobal("window", {
      setTimeout: (callback: () => void) => {
        callback();
        return 1;
      },
    });

    try {
      downloadCanonicalJson("request-1-serving-receipt.json", {
        requestId: "request-1",
      });

      expect(anchor).toMatchObject({
        download: "request-1-serving-receipt.json",
        hidden: true,
        href: "blob:serving-receipt",
      });
      expect(append).toHaveBeenCalledWith(anchor);
      expect(click).toHaveBeenCalledOnce();
      expect(remove).toHaveBeenCalledOnce();
      expect(revokeObjectURL).toHaveBeenCalledWith(
        "blob:serving-receipt",
      );
      expect(await downloadedBlob!.text()).toBe(
        '{\n  "requestId": "request-1"\n}\n',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

function servingProjection() {
  return ManagedAdapterServingProjectionSchema.parse({
    schemaVersion: "openpond.managedAdapterServingProjection.v1",
    teamId: "team-1",
    source: "openpond_training",
    sourceRef: "lineage-1",
    canonicalArtifactId: "artifact-1",
    canonicalArtifactState: "promotable",
    canonicalDeploymentId: "deployment-1",
    canonicalDeploymentState: "failed",
    state: "imported",
    artifactContentHash: hash("1"),
    baseProfileId: "qwen3-0-6b-c1899de2",
    evaluation: evaluationEvidence(),
    deployment: null,
    servingPool: {
      id: "pool-1",
      baseProfileId: "qwen3-0-6b-c1899de2",
      provider: "prime_vllm",
      state: "failed",
      workersMin: 0,
      workersMax: 1,
      idleTimeoutSeconds: 300,
      providerConfigurationHash: hash("2"),
      leaseExpiresAt: "2026-07-27T05:10:00.000Z",
      estimatedHourlyUsd: "1.290000",
      lastReconciledAt: "2026-07-27T06:00:00.000Z",
      failureCode: "pool_retired",
      createdAt: "2026-07-27T04:40:00.000Z",
      updatedAt: "2026-07-27T06:00:00.000Z",
    },
    servingReceipts: [servingReceiptRecord()],
    publishedAt: "2026-07-27T04:30:53.781Z",
    lastSyncedAt: "2026-07-27T06:00:00.000Z",
    lastError: null,
  });
}

function evaluationEvidence() {
  return {
    schemaVersion: "openpond.modelAdapterEvaluation.v1",
    evaluationId: "evaluation-1",
    role: "chat_manual",
    policyId: "qwen3-chat-manual-beta-r1",
    policyRevision: 1,
    policyHash: hash("3"),
    tasksetId: "taskset-1",
    tasksetHash: hash("4"),
    baselineScore: 1 / 3,
    candidateScore: 1 / 3,
    threshold: 0,
    minimumCandidateScore: 0.75,
    passed: true,
    frozenEvaluatorHash: hash("5"),
    compatibility: {
      passed: true,
      workerImageDigest: `sha256:${hash("6")}`,
      baseProfileHash: hash("7"),
      diagnosticSetHash: hash("8"),
      testedAt: "2026-07-27T04:30:53.000Z",
    },
    resultHashes: {
      baselineOutputsHash: hash("9"),
      candidateOutputsHash: hash("a"),
      diagnosticOutputsHash: hash("b"),
      resultSetHash: hash("c"),
    },
    evidenceHash: hash("d"),
    completedAt: "2026-07-27T04:30:53.781Z",
  };
}

function servingReceiptRecord() {
  return {
    schemaVersion: "openpond.modelAdapterServingReceiptRecord.v1",
    requestId: "request-1",
    state: "reconciled",
    artifactId: "artifact-1",
    deploymentId: "deployment-1",
    poolId: "pool-1",
    provider: "prime_vllm",
    receipt: {
      schemaVersion: "openpond.modelAdapterServingReceipt.v1",
      correlation: {
        requestId: "request-1",
        providerJobId: "provider-job-1",
        deploymentId: "deployment-1",
        poolId: "pool-1",
        provider: "prime_vllm",
        providerEndpointId: "prime-endpoint-1",
      },
      identity: {
        logicalModelName: "trained-model",
        baseProfileId: "qwen3-0-6b-c1899de2",
        baseRepository: "Qwen/Qwen3-0.6B",
        baseRevision: "c1899de289a04d12100db370d81485cdf75e47ca",
        workerImage: `worker@sha256:${hash("e")}`,
        workerBootId: "worker-boot-1",
        artifactId: "artifact-1",
        artifactContentHash: hash("1"),
        requestedAlias: "lora_71b204631fe45791697ba622",
        resolvedManifestSha256: hash("f"),
        appliedVllmAdapterId: 1_907_491_939,
      },
      state: {
        requestTemperature: "warm",
        adapterCacheHit: true,
        baseEngineInitializationCount: 1,
        outcome: "succeeded",
        scaleToZero: {
          observed: false,
          observedAt: null,
          durationMs: null,
        },
      },
      timestamps: {
        requestStartedAt: "2026-07-27T05:00:00.000Z",
        firstOutputAt: "2026-07-27T05:00:00.050Z",
        completedAt: "2026-07-27T05:00:00.085Z",
      },
      durationsMs: {
        adapterMaterialization: 0,
        timeToFirstToken: 49.929,
        generation: 84.928,
        totalRequest: 85,
      },
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
        providerUsageSource: "estimated",
      },
      cost: {
        currency: "USD",
        providerReportedUsd: null,
        estimatedUsd: 0.000031,
        estimateMethodology: "prime_raw_gpu_quote_worker_seconds_v1",
      },
      rawWorkerTelemetrySha256: hash("0"),
      contentHash: hash("f"),
    },
    createdAt: "2026-07-27T05:00:00.000Z",
    completedAt: "2026-07-27T05:00:00.085Z",
    reconciledAt: "2026-07-27T05:00:00.100Z",
  };
}

function hash(character: string): string {
  return character.repeat(64);
}
