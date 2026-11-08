import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { canonicalSha256 } from "openpond-sdk/training";
import {
  createOpenPondMcpServer,
  OpenPondMcpAuthorizationError,
  OPENPOND_APP_MCP_SCOPES,
  handleOpenPondMcpRequest,
} from "../dist/index.js";

// Failure story: dropping an expected Dataset validation status makes authoring
// look like an internal failure; echoing its raw server message can expose data.
test("Dataset validation errors retain safe recovery and uncertain outcomes", async () => {
  let status = 422;
  const privateDiagnostic = "private-provider-diagnostic-do-not-return";
  const server = createOpenPondMcpServer({
    baseUrl: "https://api.openpond.ai",
    context: { userId: "qualification-user", teamId: "qualification-workspace", scopes: ["app:write"], authorize: async () => {} },
    fetch: async () => Response.json({ code: "dataset_validation_failed", message: privateDiagnostic }, { status }),
  });
  const client = new Client({ name: "dataset-error-qualification", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  try {
    const rejected = await client.callTool({ name: "datasets_validate", arguments: { id: "qualification-dataset", expectedRevision: 3 } });
    assert.equal(rejected.isError, true);
    const validation = JSON.parse(rejected.content[0].text);
    assert.equal(validation.code, "dataset_validation_failed");
    assert.equal(validation.status, 422);
    assert.equal(validation.retryable, false);
    assert.equal(validation.outcomeUnknown, false);
    assert.equal(JSON.stringify(rejected).includes(privateDiagnostic), false);
    status = 500;
    const failed = await client.callTool({ name: "datasets_validate", arguments: { id: "qualification-dataset", expectedRevision: 3 } });
    const unknown = JSON.parse(failed.content[0].text);
    assert.equal(failed.isError, true);
    assert.equal(unknown.status, 500);
    assert.equal(unknown.retryable, true);
    assert.equal(unknown.outcomeUnknown, true);
    assert.notEqual(unknown.message, validation.message, "An uncertain server failure must not claim a completed validation rejection");
    assert.equal(JSON.stringify(failed).includes(privateDiagnostic), false);
  } finally { await client.close(); await server.close(); }
});

// Failure story: a client that bypasses discovery must never execute a hidden
// mutation, and revoking a grant after initialization must stop subsequent calls.
test("MCP discovery, calls and reconnect retain the authorization boundary", async () => {
  let active = true;
  let requests = 0;
  const context = {
    userId: "qualification-user",
    teamId: "qualification-workspace",
    scopes: ["app:read"],
    authorize: async () => {
      if (!active) throw new OpenPondMcpAuthorizationError("invalid_token");
    },
    authorizationChallenge: (code, scopes) => `Bearer error="${code}", scope="${scopes.join(" ")}"`,
  };
  const options = {
    baseUrl: "https://api.openpond.ai",
    context,
    fetch: async () => {
      requests++;
      throw new Error("No hosted requests are authorized by this qualification");
    },
  };
  const server = createOpenPondMcpServer(options);
  const client = new Client({ name: "boundary-qualification", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  try {
    const discovery = await client.listTools();
    assert.equal(discovery.nextCursor, undefined);
    assert.ok(Buffer.byteLength(JSON.stringify(discovery)) <= 1_048_576);
    assert.ok(discovery.tools.every((tool) => tool.annotations.readOnlyHint));
    assert.ok(
      discovery.tools.every((tool) =>
        tool._meta.securitySchemes.every((scheme) =>
          scheme.scopes.every((scope) => scope === "app:read"),
        ),
      ),
    );
    const names = discovery.tools.map((tool) => tool.name);
    assert.equal(names.length, new Set(names).size);
    assert.ok(names.includes("connection_context"));
    assert.ok(!names.includes("experiments_run"));
    const result = await client.callTool({ name: "connection_context", arguments: {} });
    assert.equal(result.structuredContent.result.teamId, context.teamId);
    const denied = await client.callTool({ name: "experiments_run", arguments: {} });
    assert.equal(denied.isError, true);
    assert.match(denied._meta["mcp/www_authenticate"][0], /insufficient_scope/);
    assert.equal(requests, 0);
    active = false;
    const revoked = await client.callTool({ name: "connection_context", arguments: {} });
    assert.equal(revoked.isError, true);
    assert.match(revoked._meta["mcp/www_authenticate"][0], /invalid_token/);
    await assert.rejects(client.listTools());
    assert.equal(requests, 0);
  } finally {
    await client.close();
    await server.close();
  }
});

// Strict function-calling clients represent omitted optional fields as null.
// Prove the real protocol/SDK adapter accepts that form without changing
// explicit nullable values, repairing unions, or weakening required inputs.
test("strict-client optional nulls retain the API validation boundary", async () => {
  const teamId = "qualification-workspace";
  const observed = [];
  const server = createOpenPondMcpServer({
    baseUrl: "https://api.openpond.ai",
    context: {
      userId: "qualification-user",
      teamId,
      scopes: ["app:read", "app:write"],
      authorize: async () => {},
    },
    fetch: async (request) => {
      const url = new URL(request.url);
      const body = request.method === "PUT" ? await request.json() : undefined;
      observed.push({ method: request.method, url, body });
      if (url.pathname === "/v1/training-projects" && request.method === "GET") {
        assert.equal(url.searchParams.has("cursor"), false);
        return Response.json({ teamId, projects: [], nextCursor: null });
      }
      if (url.pathname === "/v1/dataset-workspaces" && request.method === "GET") {
        assert.equal(url.searchParams.get("limit"), "100");
        assert.equal(url.searchParams.get("sort"), "id");
        assert.equal(url.searchParams.has("cursor"), false);
        return Response.json({ teamId, datasets: [], nextCursor: null });
      }
      assert.equal(request.method, "PUT");
      assert.equal(url.pathname, "/v1/training-projects/qualification-project");
      return Response.json({
        schemaVersion: "openpond.trainingProject.v1",
        id: body.id,
        teamId,
        creatorUserId: "qualification-user",
        revision: body.expectedRevision + 1,
        content: body.content,
        archived: false,
        createdAt: "2026-10-23T00:00:00Z",
        updatedAt: "2026-10-23T00:00:00Z",
      });
    },
  });
  const client = new Client({ name: "strict-client-qualification", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  try {
    const cursorInput = Object.freeze({ cursor: null });
    const listed = await client.callTool({ name: "projects_list", arguments: cursorInput });
    assert.notEqual(listed.isError, true);
    assert.deepEqual(listed.structuredContent.result, { teamId, projects: [], nextCursor: null });
    assert.deepEqual(cursorInput, { cursor: null });
    const datasets = await client.callTool({
      name: "datasets_list",
      arguments: {
        cursor: null,
        projectId: null,
        search: null,
        sort: null,
        limit: null,
      },
    });
    assert.notEqual(datasets.isError, true);
    const input = {
      operationId: "qualification-operation",
      id: "qualification-project",
      expectedRevision: 0,
      ownerScope: null,
      content: {
        name: "Qualification",
        description: "",
        targets: [],
        defaultTargetId: null,
        resources: [
          { kind: "dataset", resourceId: "qualification-dataset", role: "training", release: null },
        ],
      },
    };
    const original = structuredClone(input);
    const saved = await client.callTool({ name: "projects_save", arguments: input });
    assert.notEqual(saved.isError, true);
    assert.equal(Object.hasOwn(observed.at(-1).body, "ownerScope"), false);
    assert.equal(observed.at(-1).body.content.defaultTargetId, null);
    assert.equal(observed.at(-1).body.content.resources[0].release, null);
    assert.deepEqual(input, original);
    const source = {
      profileId: "qualification-profile",
      sourceRevision: "revision",
      harnessRelease: { id: "qualification-harness", contentHash: "a".repeat(64) },
      catalogHash: "b".repeat(64),
      definitionId: "qualification-definition",
      definitionHash: "c".repeat(64),
      target: { kind: "profile" },
      environmentHash: "d".repeat(64),
    };
    const unionInput = structuredClone(input);
    unionInput.content.targets = [
      {
        id: "qualification-target",
        name: "Target",
        target: { kind: "harness", profileRepositoryId: "qualification-profile", source },
      },
    ];
    assert.notEqual(
      (await client.callTool({ name: "projects_save", arguments: unionInput })).isError,
      true,
    );
    const requestsBeforeRejection = observed.length;
    for (const [name, args] of [
      ["projects_get", { id: null }],
      ["projects_save", { ...input, expectedRevision: null }],
      ["projects_list", { cursor: null, unknown: null }],
      [
        "projects_save",
        {
          ...unionInput,
          content: {
            ...unionInput.content,
            targets: [
              {
                ...unionInput.content.targets[0],
                target: {
                  ...unionInput.content.targets[0].target,
                  source: { ...source, sourceCandidate: null },
                },
              },
            ],
          },
        },
      ],
    ]) {
      const denied = await client.callTool({ name, arguments: args });
      assert.equal(denied.isError, true);
      assert.equal(JSON.parse(denied.content[0].text).code, "invalid_input_or_response");
    }
    assert.equal(observed.length, requestsBeforeRejection);
  } finally {
    await client.close();
    await server.close();
  }
});

// Scope-specific regressions previously allowed a cancellation grant to release
// a prepared dataset, or a review grant to cancel attached execution. Prove the
// public MCP boundary rejects those calls before parsing or reaching the API.
async function verifyEffectSeparation() {
  for (const [scopes, names] of [
    [
      ["app:cancel"],
      ["dataset_preparations_release", "dataset_preparations_start", "dataset_preparations_resume"],
    ],
    [["app:review"], ["learning_cancel_iteration"]],
    [
      ["app:execute"],
      ["training_engram_start", "training_decision_start", "training_neuron_start"],
    ],
    [["app:publish"], ["learning_publish_policy"]],
  ]) {
    const server = createOpenPondMcpServer({
      baseUrl: "https://api.openpond.ai",
      context: {
        userId: "qualification-user",
        teamId: "qualification-workspace",
        scopes,
        authorize: async () => {},
      },
      fetch: async () => {
        throw new Error("Network forbidden");
      },
    });
    const client = new Client({ name: "effect-qualification", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    try {
      const discovery = await client.listTools();
      assert.ok(Buffer.byteLength(JSON.stringify(discovery)) <= 1_048_576);
      assert.ok(
        discovery.tools.every((tool) =>
          tool._meta.securitySchemes.every((scheme) =>
            scheme.scopes.every((scope) => scopes.includes(scope)),
          ),
        ),
      );
      for (const name of names) {
        assert.ok(!discovery.tools.some((tool) => tool.name === name));
        const denied = await client.callTool({ name, arguments: {} });
        assert.equal(denied.isError, true);
        assert.equal(JSON.parse(denied.content[0].text).code, "insufficient_scope");
      }
    } finally {
      await client.close();
      await server.close();
    }
  }
}

// Exercise real MCP JSON Schema negotiation and clients that list tools once:
// the complete current catalog must fit within the byte budget without hiding
// workflows behind a cursor such clients never follow.
test("all supported tools negotiate their public schemas over the MCP SDK", async () => {
  await verifyEffectSeparation();
  const server = createOpenPondMcpServer({
    baseUrl: "https://api.openpond.ai",
    context: {
      userId: "qualification-user",
      teamId: "qualification-workspace",
      scopes: OPENPOND_APP_MCP_SCOPES,
      authorize: async () => {},
    },
    fetch: async () => {
      throw new Error("Network forbidden");
    },
  });
  const client = new Client({ name: "schema-qualification", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  try {
    const result = await client.listTools();
    assert.equal(result.nextCursor, undefined);
    assert.ok(result.tools.length > 0);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 1_048_576);
    const names = new Set();
    for (const tool of result.tools) {
      assert.ok(!names.has(tool.name));
      names.add(tool.name);
    }
    for (const required of [
      "projects_save",
      "datasets_publish",
      "graders_catalog",
      "experiments_run",
      "training_preparation_start",
      "training_jobs_recover_checkpoint",
      "learning_publish_policy",
      "training_engram_start",
      "training_decision_start",
      "training_neuron_start",
      "models_version_get",
      "training_save_learning_policy",
    ])
      assert.ok(names.has(required));
  } finally {
    await client.close();
    await server.close();
  }
});

test("stateless Streamable HTTP initializes and discovers without touching a hosted workload", async () => {
  const options = {
    baseUrl: "https://openpond.ai",
    context: {
      userId: "qualification-user",
      teamId: "qualification-workspace",
      scopes: OPENPOND_APP_MCP_SCOPES,
      authorize: async () => {},
    },
    fetch: async () => {
      throw new Error("Network forbidden");
    },
  };
  const request = (body) =>
    new Request("https://openpond.ai/mcp/app", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
    });
  const response = await handleOpenPondMcpRequest(
    request({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "http-qualification", version: "1" },
      },
    }),
    options,
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.serverInfo.name, "openpond");
  // Exercise the wire envelope too, including a UTF-8 request ID larger than
  // the minimum RPC headroom rather than just adding serialized tool sizes.
  const discovery = await handleOpenPondMcpRequest(
    request({
      jsonrpc: "2.0",
      id: "qualification-" + "⚙".repeat(600),
      method: "tools/list",
    }),
    options,
  );
  const text = await discovery.text();
  assert.equal(discovery.status, 200);
  assert.ok(Buffer.byteLength(text) <= 1_048_576);
  const result = JSON.parse(text).result;
  assert.ok(result.tools.length > 0);
  assert.equal(result.nextCursor, undefined);
});

// Failure story: an MCP caller must not redirect a draft/task/funding operation
// to another workspace, consume another owner's private draft, or receive
// hidden billing data. Exercise real MCP negotiation and the public SDK's
// request/receipt hashing together rather than just checking registration.
test("training authoring, ingestion and credit preserve fixed principal and retry identity", async () => {
  const teamId = "qualification-workspace";
  const userId = "qualification-user";
  const context = {
    userId,
    teamId,
    scopes: [...OPENPOND_APP_MCP_SCOPES],
    authorize: async () => {},
  };
  let requests = 0;
  let saves = 0;
  let foreignOwner = false;
  let privateBalances = true;
  let foreignBalance = false;
  let foreignFunding = false;
  let foreignCapability = false;
  let controlPosts = 0;
  let deniedExecutionReads = 0;
  let record;
  const receipts = new Map();
  const appends = [];
  const server = createOpenPondMcpServer({
    baseUrl: "https://api.openpond.ai",
    context,
    fetch: async (request) => {
      requests++;
      assert.equal(request.headers.has("authorization"), false);
      assert.equal(request.headers.get("x-openpond-team-id"), teamId);
      const url = new URL(request.url);
      const capabilityMethods = {
        engram: "engram",
        decision: "decision",
        "neuron-training": "neuronTraining",
      };
      const capability = capabilityMethods[url.pathname.split("/").at(-1)];
      if (url.pathname.startsWith("/v1/training/modification-capabilities/") && capability) {
        const query = Object.fromEntries(url.searchParams);
        assert.equal(query.teamId, teamId);
        const now = Date.now();
        const content = {
          schemaVersion: `openpond.${capability}ExecutionCapability.v1`,
          teamId,
          actorId: foreignCapability ? "another-owner" : userId,
          query,
          requestHash: await canonicalSha256(query),
          checkedAt: new Date(now).toISOString(),
          expiresAt: new Date(now + 60_000).toISOString(),
          validationLevel: null,
          execution: {
            state: "unavailable",
            code: "runtime_not_qualified",
            reason: "Runtime has no retained qualification.",
          },
        };
        return Response.json({ ...content, contentHash: await canonicalSha256(content) });
      }
      if (url.pathname.startsWith("/v1/training/modification-executions/")) {
        if (request.method === "POST") {
          controlPosts++;
          throw new Error("No execution control is authorized for this target");
        }
        assert.equal(url.searchParams.get("teamId"), teamId);
        deniedExecutionReads++;
        // A real domain refusal must stop dispatch, even with an execute grant.
        return Response.json(
          {
            schemaVersion: "openpond.trainingApiError.v2",
            code: "execution_not_found",
            message: "Private diagnostic must not escape",
            retryable: false,
            requestId: null,
            details: {},
          },
          { status: 404 },
        );
      }
      if (url.pathname === "/v1/account/balance") {
        if (!privateBalances)
          return Response.json(
            { error: "workspace_billing_access_required", privateDiagnostic: "never expose" },
            { status: 403 },
          );
        return Response.json({
          workspace: { id: foreignBalance ? "another-workspace" : teamId, type: "team" },
          balanceKind: "prepaid_credits",
          balanceUsd: "12.340000",
          balanceUsdCents: 1234,
          currency: "USD",
          asOf: new Date().toISOString(),
          billingAccountId: "private-billing-account",
          credits: "12.340000",
          breakdown: [],
        });
      }
      if (url.pathname === "/v1/training/funding/preview") {
        const input = await request.json();
        assert.equal(input.teamId, teamId);
        const checkedAt = new Date();
        return Response.json({
          schemaVersion: "openpond.trainingFunding.v1",
          teamId,
          actorId: foreignFunding ? "another-owner" : userId,
          requestHash: await canonicalSha256(input),
          maximumSpendUsd: input.maximumSpendUsd,
          draft: input.draft,
          state: "member_limit",
          canViewBalance: false,
          canPurchase: false,
          availableUsageUsd: null,
          prepaidCreditUsd: null,
          checkedAt: checkedAt.toISOString(),
          expiresAt: new Date(checkedAt.getTime() + 60_000).toISOString(),
        });
      }
      if (url.pathname === "/v1/dataset-workspaces/qualification-dataset/tasks") {
        const input = await request.json();
        appends.push(input);
        return Response.json({
          schemaVersion: "openpond.datasetTaskReceipt.v1",
          teamId,
          datasetId: "qualification-dataset",
          taskId: "retained-task",
          operationId: input.operationId,
          receivedAt: "2026-11-07T16:00:00Z",
          revision: 2,
          state: "saved",
          trainingUseAuthorized: false,
        });
      }
      if (url.pathname === "/v1/training/experiment-drafts" && request.method === "POST") {
        const input = await request.json();
        assert.equal(input.teamId, teamId);
        if (receipts.has(input.operationId)) return Response.json(receipts.get(input.operationId));
        if (input.expectedRevision !== (record?.revision ?? 0))
          return Response.json(
            {
              schemaVersion: "openpond.trainingApiError.v2",
              code: "revision_conflict",
              message: "Another revision was saved.",
              retryable: false,
              requestId: null,
              details: {},
            },
            { status: 409 },
          );
        const content = {
          schemaVersion: "openpond.experimentDraftRecord.v1",
          id: input.draft.id,
          teamId,
          ownerUserId: userId,
          projectId: input.projectId,
          revision: input.expectedRevision + 1,
          status: "draft",
          draft: input.draft,
          createdAt: "2026-11-07T16:00:00Z",
          updatedAt: "2026-11-07T16:00:00Z",
        };
        record = { ...content, contentHash: await canonicalSha256(content) };
        saves++;
        const receipt = {
          schemaVersion: "openpond.experimentDraftReceipt.v1",
          operationId: input.operationId,
          requestHash: await canonicalSha256(input),
          record,
        };
        receipts.set(input.operationId, receipt);
        return Response.json(receipt);
      }
      if (url.pathname === "/v1/training/experiment-drafts/qualification-draft") {
        assert.equal(url.searchParams.get("teamId"), teamId);
        const { contentHash: _hash, ...content } = record;
        if (foreignOwner) content.ownerUserId = "another-owner";
        return Response.json({ ...content, contentHash: await canonicalSha256(content) });
      }
      throw new Error("Unexpected hosted route");
    },
  });
  const client = new Client({ name: "training-workflow-qualification", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const call = (name, args) => client.callTool({ name, arguments: args });
  try {
    const draft = {
      schemaVersion: "openpond.experimentDraft.v1",
      id: "qualification-draft",
      operationType: "evaluate",
      name: "Reviewed evaluation",
    };
    const save = {
      schemaVersion: "openpond.experimentDraftSave.v1",
      operationId: "same-save",
      expectedRevision: 0,
      projectId: null,
      draft,
    };
    const first = await call("experiment_drafts_save", save);
    assert.notEqual(first.isError, true);
    assert.deepEqual(
      (await call("experiment_drafts_save", save)).structuredContent,
      first.structuredContent,
    );
    assert.equal(saves, 1);
    assert.equal(
      (await call("experiment_drafts_get", { id: draft.id })).structuredContent.result.revision,
      1,
    );
    foreignOwner = true;
    assert.equal((await call("experiment_drafts_get", { id: draft.id })).isError, true);
    foreignOwner = false;
    assert.equal(
      (await call("experiment_drafts_save", { ...save, operationId: "stale-write" })).isError,
      true,
    );
    assert.equal(saves, 1);
    const beforeInvalid = requests;
    assert.equal(
      (await call("experiment_drafts_save", { ...save, teamId: "other-workspace" })).isError,
      true,
    );
    assert.equal(
      (
        await call("experiment_drafts_save", {
          ...save,
          draft: { ...draft, operationType: "alphaedit" },
        })
      ).isError,
      true,
    );
    assert.equal(requests, beforeInvalid);

    const task = {
      schemaVersion: "openpond.datasetTaskAppend.v1",
      datasetId: "qualification-dataset",
      operationId: "same-source-event",
      task: { name: "Observed failure", input: { error: "Expired session" }, expectedOutput: null },
    };
    const appended = await call("datasets_add_task", task);
    assert.notEqual(appended.isError, true);
    assert.equal(appended.structuredContent.result.trainingUseAuthorized, false);
    assert.deepEqual(
      (await call("datasets_add_task", task)).structuredContent,
      appended.structuredContent,
    );
    assert.deepEqual(appends[0], appends[1]);

    const balance = await call("account_credit_balance", {});
    assert.notEqual(balance.isError, true);
    assert.equal(balance.structuredContent.result.balanceUsd, "12.340000");
    assert.equal(JSON.stringify(balance).includes("private-billing-account"), false);
    foreignBalance = true;
    assert.equal((await call("account_credit_balance", {})).isError, true);
    foreignBalance = false;
    privateBalances = false;
    const deniedBalance = await call("account_credit_balance", {});
    assert.equal(deniedBalance.isError, true);
    assert.equal(JSON.stringify(deniedBalance).includes("never expose"), false);
    const funding = {
      schemaVersion: "openpond.trainingFundingRequest.v1",
      maximumSpendUsd: 25,
      draft: null,
    };
    const coverage = await call("training_funding_preview", funding);
    assert.notEqual(coverage.isError, true);
    assert.equal(coverage.structuredContent.result.canViewBalance, false);
    assert.equal(coverage.structuredContent.result.prepaidCreditUsd, null);
    foreignFunding = true;
    assert.equal((await call("training_funding_preview", funding)).isError, true);

    const source = {
      modelId: "qualified/base",
      source: "managed",
      revision: "exact-revision",
      tokenizerRevision: "exact-tokenizer",
    };
    for (const family of ["engram", "decision", "neuron"]) {
      const capability = await call(`training_${family}_capabilities`, source);
      assert.notEqual(capability.isError, true);
      assert.equal(capability.structuredContent.result.execution.state, "unavailable");
      assert.equal(capability.structuredContent.result.validationLevel, null);
      foreignCapability = true;
      assert.equal((await call(`training_${family}_capabilities`, source)).isError, true);
      foreignCapability = false;
      const beforeScopeOverride = requests;
      assert.equal(
        (await call(`training_${family}_capabilities`, { ...source, teamId: "other-workspace" }))
          .isError,
        true,
      );
      assert.equal(requests, beforeScopeOverride);
      const denied = await call(`training_${family}_start`, {
        id: "another-method-or-owner",
        operationId: `unchanged-${family}`,
        expectedRevision: 1,
        planHash: "a".repeat(64),
        approvedMaximumSpendUsd: "1",
      });
      assert.equal(denied.isError, true);
      assert.equal(JSON.stringify(denied).includes("Private diagnostic"), false);
    }
    assert.equal(deniedExecutionReads, 3);
    assert.equal(controlPosts, 0);
    const beforeRetired = requests;
    for (const name of [
      "human_review_create",
      "human_review_submit",
      "learning_schedule_list",
      "learning_publish_resources",
      "learning_publish_reward",
      "learning_corrections_declare_verification",
    ])
      await assert.rejects(call(name, {}), /Unknown OpenPond tool/);
    assert.equal(requests, beforeRetired);

    context.scopes = ["app:read"];
    const beforeHidden = requests;
    assert.equal((await call("datasets_add_task", task)).isError, true);
    assert.equal((await call("experiment_drafts_save", save)).isError, true);
    assert.equal(requests, beforeHidden);
  } finally {
    await client.close();
    await server.close();
  }
});

// Failure story: paging only after fetching the whole history defeats the
// backend bound; trusting a foreign or shifted page can leak/misattribute run
// evidence. Exercise actual MCP negotiation and SDK receipt verification.
test("training evidence requests one bounded upstream page and rejects a mismatched receipt", async () => {
  let calls = 0;
  let foreignJob = false;
  const server = createOpenPondMcpServer({
    baseUrl: "https://api.openpond.ai",
    context: { userId: "qualification-user", teamId: "qualification-workspace", scopes: ["app:read"], authorize: async () => {} },
    fetch: async request => {
      calls++;
      const url = new URL(request.url);
      assert.equal(url.searchParams.get("after"), "7");
      assert.equal(url.searchParams.get("limit"), "1");
      const kind = url.pathname.endsWith("/events") ? "events" : "logs";
      return Response.json({ [kind]: [{
        schemaVersion: kind === "events" ? "openpond.trainingJobEvent.v2" : "openpond.trainingJobLog.v2",
        jobId: foreignJob ? "foreign-job" : "qualification-job", sequence: 7,
        ...(kind === "events" ? { id: "retained-event", type: "optimizer_metric", phase: "committed", data: {} } : { level: "info" }),
        message: "Retained evidence", createdAt: "2026-11-07T00:00:00Z",
      }], nextOffset: 8 });
    },
  });
  const client = new Client({ name: "paged-evidence-qualification", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  try {
    for (const tool of ["training_jobs_events", "training_jobs_logs"]) {
      const result = await client.callTool({ name: tool, arguments: { id: "qualification-job", after: 7, limit: 1 } });
      assert.notEqual(result.isError, true);
      assert.equal(result.structuredContent.result.items.length, 1);
      assert.equal(result.structuredContent.result.items[0].sequence, 7);
      assert.equal(result.structuredContent.result.nextOffset, 8);
    }
    assert.equal(calls, 2);
    foreignJob = true;
    const denied = await client.callTool({ name: "training_jobs_events", arguments: { id: "qualification-job", after: 7, limit: 1 } });
    assert.equal(denied.isError, true);
    assert.equal(calls, 3);
  } finally {
    await client.close();
    await server.close();
  }
});
