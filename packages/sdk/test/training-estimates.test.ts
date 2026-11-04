import { createServer } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { canonicalSha256, createTrainingClient, OPENPOND_TRAINING_MEDIA_TYPE,
  TrainingEstimateRequestSchema, TrainingEstimateSchema } from "../src/training.js";

// An immutable import receipt must bind the requested Dataset, explicit sharing
// and operation even when the HTTP response itself is well-formed and rehashed.
it("verifies Dataset review receipt bindings over actual HTTP", async () => {
  const fixture = JSON.parse(await readFile(new URL("../fixtures/python-foundation/dataset-training-review-http-workflow.json", import.meta.url), "utf8"));
  let mode = "valid", posts = 0;
  const server = createServer(async (incoming, outgoing) => {
    expect(incoming.method).toBe("POST");
    expect(incoming.url).toBe("/v1/training/dataset-reviews");
    expect(incoming.headers["content-type"]).toBe(OPENPOND_TRAINING_MEDIA_TYPE);
    const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
    expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual(fixture.request);
    posts++;
    const value = structuredClone(fixture.response);
    if (mode === "dataset") value.dataset.contentHash = "e".repeat(64);
    if (mode === "team") value.teamId = "other-team";
    if (mode === "operation") value.operationId = "other-operation";
    if (mode === "id") value.id = "another-receipt";
    if (mode === "request") value.requestHash = "e".repeat(64);
    if (mode === "inventory") value.evidence.push(value.evidence[0]);
    if (mode === "sharing") value.shareWithWorkspace = false;
    const { contentHash: _hash, ...content } = value;
    value.contentHash = mode === "hash" ? "e".repeat(64) : await canonicalSha256(content);
    outgoing.writeHead(200, { "content-type": OPENPOND_TRAINING_MEDIA_TYPE }); outgoing.end(JSON.stringify(value));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Expected HTTP listener");
    const client = createTrainingClient({ baseUrl: `http://127.0.0.1:${address.port}` });
    expect(await client.reviewDataset(fixture.request)).toEqual(fixture.response);
    for (const invalid of ["dataset", "team", "operation", "id", "request", "inventory", "sharing", "hash"]) {
      mode = invalid; await expect(client.reviewDataset(fixture.request)).rejects.toBeDefined();
    }
    const before = posts;
    await expect(client.reviewDataset({ ...fixture.request, shareWithWorkspace: false })).rejects.toBeDefined();
    await expect(client.reviewDataset({ ...fixture.request, taskIds: ["duplicate", "duplicate"] })).rejects.toBeDefined();
    expect(posts).toBe(before);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

// Failure story: a successful planning reply must not authorize a different
// preparation or carry an expired/substituted review into an explicit start.
it("retains exact estimate review across HTTP and rejects mismatched or expired replies", async () => {
  const fixture = JSON.parse(await readFile(new URL("../fixtures/python-foundation/training-estimate-http-workflow.json", import.meta.url), "utf8"));
  const request = TrainingEstimateRequestSchema.parse(fixture.request);
  const reply = fixture.response;
  reply.requestHash = await canonicalSha256(request);
  reply.review.requestHash = reply.requestHash;
  reply.createdAt = new Date().toISOString();
  reply.expiresAt = reply.review.expiresAt = new Date(Date.now() + 60_000).toISOString();
  let mode = "valid";
  const server = createServer(async (incoming, outgoing) => {
    expect(incoming.method).toBe("POST");
    expect(incoming.url).toBe("/v1/training/estimates");
    expect(incoming.headers["content-type"]).toBe(OPENPOND_TRAINING_MEDIA_TYPE);
    const parts = []; for await (const part of incoming) parts.push(part);
    expect(JSON.parse(Buffer.concat(parts).toString())).toEqual(request);
    const result = structuredClone(reply);
    if (mode === "source") result.source.contentHash = "e".repeat(64);
    if (mode === "review") result.review.inputHash = "e".repeat(64);
    if (mode === "request") result.requestHash = result.review.requestHash = "e".repeat(64);
    if (mode === "expiry") {
      result.createdAt = new Date(Date.now() - 120_000).toISOString();
      result.expiresAt = result.review.expiresAt = new Date(Date.now() - 60_000).toISOString();
    }
    if (mode === "count") result.gpu.resolved.gpuCount = 2;
    if (mode === "range") result.executionSeconds.planningRange = { low: 300, high: 100 };
    outgoing.writeHead(200, { "content-type": OPENPOND_TRAINING_MEDIA_TYPE }); outgoing.end(JSON.stringify(result));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Expected HTTP listener");
    const client = createTrainingClient({ baseUrl: `http://127.0.0.1:${address.port}` });
    expect(await client.estimate(request)).toEqual(TrainingEstimateSchema.parse(reply));
    for (const invalid of ["source", "review", "request", "expiry", "count", "range"]) {
      mode = invalid; await expect(client.estimate(request)).rejects.toBeDefined();
    }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

// Failure story: a successful funding read must not reveal a private balance or
// send the user to Billing for a different saved draft, cap or workspace.
it("binds funding previews and grantless Billing handoffs across actual HTTP", async () => {
  const fixture = JSON.parse(await readFile(new URL("../fixtures/python-foundation/training-funding-http-workflow.json", import.meta.url), "utf8"));
  let mode = "valid";
  const server = createServer(async (incoming, outgoing) => {
    const handoff = incoming.url === "/v1/training/funding/handoff";
    expect(incoming.method).toBe("POST");
    expect(incoming.url).toBe(handoff ? "/v1/training/funding/handoff" : "/v1/training/funding/preview");
    expect(incoming.headers["content-type"]).toBe(OPENPOND_TRAINING_MEDIA_TYPE);
    const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
    const request = handoff ? fixture.handoffRequest : fixture.request;
    expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual(request);
    const value = structuredClone(handoff ? fixture.handoffResponse : fixture.response);
    value.requestHash = await canonicalSha256(request);
    value.checkedAt = new Date().toISOString(); value.expiresAt = new Date(Date.now() + 60_000).toISOString();
    if (mode === "cap") value.maximumSpendUsd++;
    if (mode === "draft") value.draft.contentHash = "e".repeat(64);
    if (mode === "team") value.teamId = "other-team";
    if (mode === "hash") value.requestHash = "e".repeat(64);
    if (mode === "expiry") { value.checkedAt = new Date(Date.now() - 120_000).toISOString(); value.expiresAt = new Date(Date.now() - 60_000).toISOString(); }
    if (mode === "privacy") value.availableUsageUsd = "999";
    if (mode === "url") value.billingUrl = "https://app.example.test/entry/" + "A".repeat(64) + "?redirect=https://elsewhere.example";
    if (mode === "permission") value.canPurchase = false;
    outgoing.writeHead(200, { "content-type": OPENPOND_TRAINING_MEDIA_TYPE }); outgoing.end(JSON.stringify(value));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Expected HTTP listener");
    const client = createTrainingClient({ baseUrl: `http://127.0.0.1:${address.port}` });
    expect((await client.funding(fixture.request)).state).toBe("covered");
    for (const invalid of ["cap", "draft", "team", "hash", "expiry", "privacy"]) { mode = invalid; await expect(client.funding(fixture.request)).rejects.toBeDefined(); }
    mode = "valid"; expect((await client.fundingHandoff(fixture.handoffRequest)).billingUrl).toBe(fixture.handoffResponse.billingUrl);
    for (const invalid of ["cap", "draft", "team", "hash", "expiry", "url", "permission"]) { mode = invalid; await expect(client.fundingHandoff(fixture.handoffRequest)).rejects.toBeDefined(); }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
