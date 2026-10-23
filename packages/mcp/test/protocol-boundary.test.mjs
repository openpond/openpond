import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createOpenPondMcpServer,
  OpenPondMcpAuthorizationError,
  OPENPOND_APP_MCP_SCOPES,
  handleOpenPondMcpRequest,
} from "../dist/index.js";

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
    [["app:review"], ["human_review_cancel"]],
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
    assert.equal(result.tools.length, 179);
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
      "human_review_submit",
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
  assert.equal(result.tools.length, 179);
  assert.equal(result.nextCursor, undefined);
});
