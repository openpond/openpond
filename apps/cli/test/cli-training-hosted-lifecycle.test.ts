import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, test } from "vitest";
import { createTrainingClient, type TrainingJob } from "openpond-sdk/training";
import { cancelHostedTrainingJob, watchHostedTrainingJob } from "../src/cli/training-hosted-lifecycle";

const hash = "a".repeat(64);
const timestamp = "2026-10-12T18:00:00.000Z";
const job = (state: TrainingJob["state"], version: number): TrainingJob => ({
  schemaVersion: "openpond.trainingJob.v2", id: "job-1", teamId: "team-1",
  kind: "policy_optimize", modelProjectId: "model-1", portableProjectId: "portable-1",
  sourceProjectRevision: 1, submissionHash: hash, state, phase: state, version, progress: 0,
  rolloutProgress: { groupsCompleted: 0, groupsTarget: 1, optimizerUpdatesApplied: 0, optimizerUpdatesSkipped: 0 },
  accruedSpendUsd: 0, terminalReason: null, createdAt: timestamp, updatedAt: timestamp,
  completedAt: ["succeeded", "cancelled", "failed"].includes(state) ? timestamp : null,
});
const receipt = {
  schemaVersion: "openpond.trainingExecutionReceipt.v2", id: "receipt-1", teamId: "team-1", jobId: "job-1",
  submissionHash: hash, manifestHash: hash, recipeHash: hash, capabilityHash: hash,
  runtimeRelease: { id: "release-1", contentHash: hash }, inputs: [], outputs: [],
  spendUsd: 0, durationSeconds: 1, cleanupComplete: true, issuer: "test", issuedAt: timestamp, signature: null,
};

async function withApi(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  exercise: (client: ReturnType<typeof createTrainingClient>) => Promise<void>,
) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await exercise(createTrainingClient({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

function reply(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

describe("hosted training lifecycle over the public SDK", () => {
  // A racing progress write must not defeat the watchdog, and a terminal Job
  // must not be mistaken for a completed cleanup receipt.
  test("reconciles cancellation versions and waits for matching cleanup evidence", async () => {
    let reads = 0, cancellations = 0, outputs = 0;
    const versions: number[] = [];
    const printed: unknown[] = [];
    await withApi((request, response) => {
      if (request.method === "GET" && request.url === "/v1/training/jobs/job-1") {
        reads++;
        return reply(response, { job: job(cancellations >= 2 ? "cancelled" : "running", reads) });
      }
      if (request.method === "POST" && request.url === "/v1/training/jobs/job-1/cancel") {
        let body = "";
        request.on("data", chunk => { body += String(chunk); });
        request.on("end", () => {
          versions.push(JSON.parse(body).expectedVersion);
          cancellations++;
          if (cancellations === 1) reply(response, {
            schemaVersion: "openpond.trainingApiError.v2", code: "stale_version", message: "Version changed",
          }, 409);
          else reply(response, { job: job("cancelling", 3) });
        });
        return;
      }
      if (request.method === "GET" && request.url === "/v1/training/jobs/job-1/outputs") {
        outputs++;
        return reply(response, { schemaVersion: "openpond.trainingJobOutputs.v2", outputs: [], receipt: outputs === 1 ? null : receipt });
      }
      reply(response, { unexpected: request.url }, 500);
    }, async client => {
      await watchHostedTrainingJob({ client, jobId: "job-1", teamId: "team-1", print: value => printed.push(value),
        options: { intervalMs: 250, deadlineAt: Date.now() + 5000, cancelAt: Date.now() - 1, waitForCleanup: true, cleanupTimeoutMs: 2000 },
        requestBound: { deadlineAt: null },
      });
    });
    expect(versions).toEqual([1, 2]);
    expect(cancellations).toBe(2);
    expect(outputs).toBe(2);
    expect(printed.at(-1)).toMatchObject({ jobId: "job-1", cleanup: { scope: "job", complete: true, receipt } });
  });

  // Public successful Jobs use 'succeeded'; treating only internal 'completed'
  // as terminal used to leave the CLI polling indefinitely.
  test("recognizes public success and refuses another workspace before cancellation", async () => {
    let requests = 0;
    await withApi((request, response) => {
      requests++;
      if (request.method !== "GET") return reply(response, {}, 500);
      reply(response, { job: job("succeeded", 1) });
    }, async client => {
      await watchHostedTrainingJob({ client, jobId: "job-1", teamId: "team-1", print: () => {},
        options: { intervalMs: 250, deadlineAt: null, cancelAt: null, waitForCleanup: false, cleanupTimeoutMs: 1000 },
        requestBound: { deadlineAt: null },
      });
      await expect(cancelHostedTrainingJob(client, "job-1", "different-team")).rejects.toThrow("workspace");
    });
    expect(requests).toBe(2);
  });
});
