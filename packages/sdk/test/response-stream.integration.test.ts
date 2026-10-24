import { createServer } from "node:http";
import { once } from "node:events";
import { expect, it } from "vitest";
import { createTrainingClient } from "../src/training.js";
import { createModelProjectsClient } from "../src/model-projects.js";

// Failure story: waiting for response.text() before checking its size lets an
// oversized nonterminating server body retain memory until caller cancellation.
it("bounds both public client response streams and closes oversized HTTP bodies before EOF", async () => {
  const closed: Promise<void>[] = [];
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/training/jobs/job-1/post-training/start") {
      if (request.headers["content-type"] !== "application/json" || request.headers.accept !== "application/json") {
        response.writeHead(415).end(JSON.stringify({ code: "taskset_package_content_type_invalid" }));
        return;
      }
      let body = "";
      for await (const chunk of request) body += chunk;
      const control = JSON.parse(body);
      response.end(JSON.stringify({ schemaVersion: "openpond.postTrainingSummary.v1", id: "evaluation-1",
        teamId: "team-1", jobId: "job-1", revision: 2, planHash: control.planHash, automatic: false,
        candidate: null, state: "ready", total: 1, completed: 0, failed: 0,
        requiredOutcome: "none", reason: null, groupId: null, experimentIds: [], updatedAt: "2026-10-24T00:00:00.000Z" }));
      return;
    }
    let writes = 0;
    // Finite fixture output, deliberately no EOF. Only reader cancellation or
    // the caller's independent timeout can close this response.
    const timer = setInterval(() => {
      if (writes++ < 145) response.write("x".repeat(65_536));
      else clearInterval(timer);
    }, 1);
    closed.push(new Promise((resolve) => response.once("close", () => {
      clearInterval(timer);
      resolve();
    })));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing HTTP fixture address");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const boundedFetch: typeof fetch = (url, init) => fetch(url, {
      ...init,
      signal: AbortSignal.timeout(3_000),
    });
    await expect(createTrainingClient({ baseUrl, fetch: boundedFetch }).listJobs())
      .rejects.toMatchObject({ code: "response_too_large" });
    await expect(createModelProjectsClient({ baseUrl, fetch: boundedFetch }).list())
      .rejects.toMatchObject({ code: "response_too_large" });
    expect((await createTrainingClient({ baseUrl, fetch: boundedFetch }).postTraining.control(
      "team-1", "job-1", "start", { operationId: "control-1", expectedRevision: 1, planHash: "a".repeat(64) },
    ))?.state).toBe("ready");
    await Promise.all(closed);
    expect(closed).toHaveLength(2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}, 10_000);
