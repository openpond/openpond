import { SandboxManagedTrainingHttpClient } from "../packages/trainer-sandbox/src/index.js";
import { describe, expect, test, vi } from "vitest";

import {
  createHarnessFixture,
  createManifestFixture,
  fixtureTimestamp,
} from "./helpers/portable-training-fixtures.js";

describe("Sandbox M8 HTTP client", () => {
  test("uses the exact release, materialization, quote, approval, launch, and lifecycle endpoints", async () => {
    const calls: Array<{
      path: string;
      method: string;
      body: Record<string, unknown> | null;
    }> = [];
    const manifest = createManifestFixture();
    const inputBundleHash = "d".repeat(64);
    const request = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        calls.push({
          path: url.pathname,
          method: init?.method ?? "GET",
          body: init?.body
            ? JSON.parse(String(init.body)) as Record<string, unknown>
            : null,
        });
        if (url.pathname.endsWith("/assets")) {
          return response({
            objectRef: "r2://bundles/environment.json",
            sha256: manifest.resolvedBundleHash,
            sizeBytes: 100,
            sideEffectsStarted: false,
          }, 201);
        }
        if (url.pathname.endsWith("/releases")) {
          return response({
            releaseRef: "r2://releases/one.json",
            releaseContentHash: manifest.harnessRelease.contentHash,
            uploadReceiptHash: "a".repeat(64),
          });
        }
        if (url.pathname.endsWith("/materializations")) {
          return response({
            materializationRef: "r2://materializations/one.json",
            materializationHash: "b".repeat(64),
            environmentArchiveRef: "r2://archives/environment.tar.zst",
            environmentArchiveHash: manifest.resolvedBundleHash,
            placementCapabilityReceipt:
              manifest.runtimeTarget.dataPlane?.capabilityReceipt,
          });
        }
        if (url.pathname.endsWith("/quotes")) {
          return response({
            materializationRef: "r2://materializations/one.json",
            materializationHash: "b".repeat(64),
            quotes: [
              {
                quote: {
                  quotedAt: fixtureTimestamp,
                  hourlyUsd: "2.69",
                  diskHourlyUsd: "0.02",
                },
                quoteSignature: "signed-quote-0123456789abcdef0123456789",
                imageQualified: true,
              },
            ],
            sideEffectsStarted: false,
          });
        }
        if (url.pathname.endsWith("/approvals")) {
          return response({
            approvalLeaseRef: "signed-approval-lease",
            expiresAt: "2026-07-23T12:15:00.000Z",
          });
        }
        if (url.pathname.endsWith("/launches")) {
          return response({ job: { id: "sandbox-job-1" } }, 201);
        }
        if (url.pathname.endsWith("/cancel")) {
          return response({ job: { state: "cancelling" } });
        }
        if (url.pathname.endsWith("/logs")) {
          return response({ cursor: "1", entries: [] });
        }
        if (url.pathname.endsWith("/events")) {
          return response({
            events: [
              {
                commandType: "rollout",
                state: "completed",
                createdAt: fixtureTimestamp,
              },
              {
                commandType: "checkpoint_upload",
                state: "running",
                createdAt: fixtureTimestamp,
              },
            ],
          });
        }
        if (url.pathname.endsWith("/artifacts")) {
          return response({
            artifacts: [],
            candidateBundle: {
              inputManifestSha256: inputBundleHash,
              artifact: {
                uri: "r2://candidates/adapter.safetensors",
                sha256: "c".repeat(64),
              },
            },
          });
        }
        return response({
          job: {
            job: {
              state: "rollout_phase",
              completedGroups: 1,
              targetGroups: 2,
              updatedAt: fixtureTimestamp,
              terminalReason: null,
              version: 3,
            },
          },
        });
      },
    );
    const client = new SandboxManagedTrainingHttpClient(
      "https://sandbox.test",
      () => ({ authorization: "Bearer scoped-service-auth" }),
      request as typeof fetch,
    );

    const environmentAsset = await client.uploadEnvironmentAsset({
      value: { schemaVersion: "openpond.managedRftEnvironment.v1" },
      expectedSha256: manifest.resolvedBundleHash,
      idempotencyKey: "environment-asset-idempotency-key",
    });
    const uploaded = await client.uploadHarnessRelease({
      release: createHarnessFixture().release,
      assetBundle: {
        objectRef: environmentAsset.objectRef,
        sha256: environmentAsset.sha256,
        sizeBytes: environmentAsset.sizeBytes,
      },
      idempotencyKey: "release-idempotency-key",
    });
    const materialized = await client.materialize({
      manifest,
      releaseRef: uploaded.releaseRef,
      releaseContentHash: uploaded.releaseContentHash,
      projection: "environment",
    });
    const quote = await client.quote({
      manifest,
      materializationRef: materialized.materializationRef,
      materializationHash: materialized.materializationHash,
    });
    const approval = await client.approve({
      manifestHash: manifest.contentHash,
      materializationRef: materialized.materializationRef,
      materializationHash: materialized.materializationHash,
      providerQuote: quote.providerQuote,
      quoteSignature: quote.quoteSignature,
      maximumSpendUsd: 9,
      approvalHash: manifest.approval.approvalHash,
    });
    const ref = await client.launch({
      runId: manifest.id,
      manifestHash: manifest.contentHash,
      name: "OpenPond exact manifest",
      inputBundle: {
        harnessRunManifest: manifest,
        manifestSha256: inputBundleHash,
      },
      approvalLeaseRef: approval.approvalLeaseRef,
      idempotencyKey: "launch-idempotency-key",
    });
    expect(ref).toMatchObject({
      manifestHash: manifest.contentHash,
      inputBundleHash,
    });

    expect(await client.status(ref)).toMatchObject({
      runId: manifest.id,
      state: "running",
      progress: 0.5,
    });
    await client.logs(ref);
    expect(await client.events(ref, -1)).toMatchObject([
      { sequence: 0, type: "complete" },
      { sequence: 1, type: "checkpoint" },
    ]);
    expect(await client.events(ref, 0)).toMatchObject([
      { sequence: 1, type: "checkpoint" },
    ]);
    await client.cancel(ref);
    const restartedClient = new SandboxManagedTrainingHttpClient(
      "https://sandbox.test",
      () => ({ authorization: "Bearer scoped-service-auth" }),
      request as typeof fetch,
    );
    expect(await restartedClient.artifacts(ref)).toMatchObject({
      runId: manifest.id,
      manifestHash: manifest.contentHash,
      artifacts: [
        {
          kind: "adapter",
          objectRef: "r2://candidates/adapter.safetensors",
        },
      ],
    });

    expect(calls.map((call) => call.path)).toEqual([
      "/v1/managed-rft/assets",
      "/v1/managed-rft/releases",
      "/v1/managed-rft/materializations",
      "/v1/managed-rft/quotes",
      "/v1/managed-rft/approvals",
      "/v1/managed-rft/launches",
      "/v1/managed-rft/jobs/sandbox-job-1",
      "/v1/managed-rft/jobs/sandbox-job-1/logs",
      "/v1/managed-rft/jobs/sandbox-job-1/events",
      "/v1/managed-rft/jobs/sandbox-job-1/events",
      "/v1/managed-rft/jobs/sandbox-job-1",
      "/v1/managed-rft/jobs/sandbox-job-1/cancel",
      "/v1/managed-rft/jobs/sandbox-job-1/artifacts",
    ]);
    expect(calls[2]?.body).toMatchObject({
      releaseContentHash: manifest.harnessRelease.contentHash,
      projection: "environment",
    });
    expect(calls[4]?.body).toMatchObject({
      manifestHash: manifest.contentHash,
      materializationRef: materialized.materializationRef,
      materializationHash: materialized.materializationHash,
      maximumSpendUsd: 9,
    });
    expect(calls[5]?.body).toMatchObject({
      approvalLeaseRef: "signed-approval-lease",
      idempotencyKey: "launch-idempotency-key",
    });
    expect(calls[11]?.body).toEqual({ expectedVersion: 3 });
    await expect(
      restartedClient.artifacts({
        ...ref,
        inputBundleHash: "e".repeat(64),
      }),
    ).rejects.toThrow(
      "Sandbox candidate artifacts changed their input-bundle lineage.",
    );
  });
});

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
