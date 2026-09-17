import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { afterEach, expect, test, vi } from "vitest";
import { contentHash } from "@openpond/harness";
import { initializeHome } from "@openpond/persistence";
import { createOpenPondAppServer, type OpenPondAppServerOptions } from "../apps/server/src/app-server-runtime";
import { SqliteStore } from "../apps/server/src/store/store";
import {
  compileLocalHarnessSource, createLocalHarnessWorkspace, localHarnessWorkspacePaths,
  materializeLocalHarnessRelease,
} from "../apps/server/src/harness/local-harness-workspace-service";

const cleanup: Array<() => Promise<void>> = [];
const argsSchema = z.object({ week: z.number().int().min(1) }).strict();
const schema = z.toJSONSchema(argsSchema, { target: "draft-7" });
const declaration = {
  name: "lookup_fixture", description: "Read an authorized fixture week.", inputSchema: schema,
  inputSchemaHash: contentHash(schema), sideEffect: "read", timeoutMs: 5_000,
};

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

async function fixture(timeoutMs = 5_000) {
  const root = await mkdtemp(path.join(os.tmpdir(), "openpond-embedding-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const storeDir = path.join(root, "state");
  await initializeHome(storeDir);
  const store = new SqliteStore(storeDir);
  try {
    const initial = await createLocalHarnessWorkspace({ store, storeDir, id: "seed", ownerId: "desktop-personal", name: "Fixture" });
    const sourceDir = localHarnessWorkspacePaths(storeDir, "seed").source;
    const manifestPath = path.join(sourceDir, "harness.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.toolDeclarations = [{ ...declaration, timeoutMs }];
    const instruction = manifest.files.find((file: { kind: string }) => file.kind === "instruction");
    await writeFile(path.join(sourceDir, instruction.path), "Always cite the fixture's input version.\n");
    await writeFile(manifestPath, JSON.stringify(manifest));
    const compiled = await compileLocalHarnessSource({ workspaceId: "embedded", sourceDir });
    const release = await materializeLocalHarnessRelease({ storeDir, workspaceId: "embedded", compiled, createdAt: new Date().toISOString() });
    await store.createHarnessWorkspaceWithRelease({
      workspace: { ...initial.workspace, id: "embedded", sourceRevision: compiled.sourceRevision,
        currentChannel: { ...initial.workspace.currentChannel, release: { id: release.harnessRelease.id, contentHash: release.harnessRelease.contentHash } } },
      release,
    });
    await store.selectHarnessWorkspace({ ownerKind: "personal", ownerId: "desktop-personal", workspaceId: "embedded", updatedAt: new Date().toISOString() });
  } finally { await store.close(); }
  return { storeDir: path.join(root, "runtime"), workspaceDir: path.join(root, "work"),
    harness: { sourceDirectory: localHarnessWorkspacePaths(storeDir, "seed").source,
      workspaceId: "application-fixture", name: "Application fixture" } };
}

async function start(options: OpenPondAppServerOptions) {
  const server = await createOpenPondAppServer(options);
  cleanup.push(server.close);
  const started = await server.runtime.threadStart({ session: {
    provider: "openpond", modelRef: { providerId: "openpond", modelId: "fixture-model" },
    experience: "work", title: "Embedded fixture", cwd: options.workspaceDir,
  } }) as { thread: { id: string } };
  return { server, threadId: started.thread.id };
}

function call(name: string, args: unknown) {
  return { type: "tool_call_delta" as const, raw: null, toolCalls: [{ id: "fixture-call", type: "function" as const,
    function: { name, arguments: JSON.stringify(args) } }] };
}

// Regression boundary: a released Harness executes a host implementation through the full
// app-server, without discovering hosted apps, losing lifecycle callbacks or bypassing revocation.
test("embedded Work binds released tools, persists lifecycle events and reauthorizes follow-ups", async () => {
  const paths = await fixture();
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected hosted request"));
  let authorized = true;
  let bindingVersion = "1";
  const execute = vi.fn(async ({ args, session, signal }: Parameters<import("../apps/server/src/app-server-runtime").AppServerToolBinding["execute"]>[0]) => {
    expect(signal.aborted).toBe(false);
    expect(session.id).toBeTruthy();
    return { week: args.week, count: 12, inputVersion: "v1" };
  });
  const finalize = vi.fn<NonNullable<OpenPondAppServerOptions["finalizeWorkTurn"]>>(async ({ session }) => session);
  const inputs = vi.fn(async () => []);
  const webSearch = vi.fn(async ({ query }: { query: string }) => ({
    query, provider: "fixture", searchedAt: new Date().toISOString(), results: [], truncated: false,
  }));
  const provider = vi.fn();
  const options: OpenPondAppServerOptions = {
    ...paths, workInputsForSession: inputs, finalizeWorkTurn: finalize, services: { webSearch },
    embedding: { allowedTools: ["lookup_fixture", "web_search"], authorizeTool: async () => {
      if (!authorized) throw new Error("Access revoked");
    }, resolveTools: async ({ declarations, harness }) => {
      expect(declarations).toHaveLength(1);
      expect(harness?.contentHash).toMatch(/^[a-f0-9]{64}$/);
      return [{ name: "lookup_fixture", version: bindingVersion, inputSchema: argsSchema, execute }];
    } },
    streamOpenPondHostedChatTurn: async function* (request) {
      provider(request);
      expect(request.tools?.map(tool => tool.function?.name).sort()).toEqual(["lookup_fixture", "web_search"]);
      expect(JSON.stringify(request.messages)).toContain("Always cite the fixture's input version.");
      if (provider.mock.calls.length % 2 === 1) {
        yield call("lookup_fixture", { week: 7 });
        const search = call("web_search", { query: "fixture" });
        search.toolCalls[0]!.id = "search-call";
        yield search;
      }
      else yield { type: "text_delta", raw: null, text: "Fixture response" };
      yield { type: "finish", raw: null, finishReason: provider.mock.calls.length % 2 ? "tool_calls" : "stop" };
    },
  };
  const { server, threadId } = await start(options);
  const run = () => server.runtime.turnStart({ threadId, input: { prompt: "Read the fixture; @slack is unconfigured." } });
  const first = await run();
  expect(first, JSON.stringify(first)).toMatchObject({ turn: { status: "completed" } });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(inputs).toHaveBeenCalledTimes(1);
  expect(webSearch).toHaveBeenCalledTimes(1);
  expect(finalize).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
  const history = await server.runtime.threadRead({ threadId });
  expect(history).toMatchObject({ turns: [expect.objectContaining({ metadata: expect.objectContaining({
    toolBindings: [{ name: "lookup_fixture", version: "1" }],
  }) })] });
  const capabilities = await server.runtime.capabilities({ threadId });
  expect(capabilities.connectedAppProviders).toEqual([]);
  expect(capabilities.features).toMatchObject({ harnessBackgroundReview: false, harnessEvaluationBaseline: false, refinerProfiles: false });
  await expect(server.runtime.refinerUpdate({ profile: {} })).rejects.toThrow(/disabled/);
  await server.close();
  cleanup.pop();
  const resumed = await createOpenPondAppServer(options);
  cleanup.push(resumed.close);
  authorized = false;
  await resumed.runtime.turnStart({ threadId, input: { prompt: "Read the fixture again." } });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(provider.mock.calls.at(-1))).toContain("Access revoked");
  expect(webSearch).toHaveBeenCalledTimes(1);
  const inferenceCalls = provider.mock.calls.length;
  bindingVersion = "2";
  expect(await resumed.runtime.turnStart({ threadId, input: { prompt: "Read it again." } }))
    .toMatchObject({ turn: { status: "failed", error: expect.stringContaining("bindings changed") } });
  expect(provider).toHaveBeenCalledTimes(inferenceCalls);
  await expect(resumed.runtime.turnStart({ threadId, input: { prompt: "Use another provider.",
    modelRef: { providerId: "codex", modelId: "fixture-model" } } })).rejects.toThrow(/configured model adapter/);
  expect(fetch).not.toHaveBeenCalled();
});

// Regression boundary: admission rejects unresolved or incompatible capabilities before inference.
test.each(["missing", "mismatched", "undeclared", "forbidden"])("rejects %s tool bindings before inference", async kind => {
  const paths = await fixture();
  const provider = vi.fn();
  const { server, threadId } = await start({ ...paths,
    embedding: { allowedTools: kind === "forbidden" ? [] : ["lookup_fixture"], authorizeTool: async () => {},
      resolveTools: async () => kind === "missing" ? [] : [{
        name: kind === "undeclared" ? "other_tool" : "lookup_fixture", version: "1",
        inputSchema: kind === "mismatched" ? z.object({ other: z.string() }) : argsSchema,
        execute: async () => ({}),
      }],
    },
    streamOpenPondHostedChatTurn: async function* () { provider(); yield { type: "text_delta", raw: null, text: "must not run" }; },
  });
  expect(await server.runtime.turnStart({ threadId, input: { prompt: "Run fixture" } })).toMatchObject({ turn: { status: "failed" } });
  expect(provider).not.toHaveBeenCalled();
});

// Regression boundary: hallucinated calls and malformed inputs never reach a handler;
// failed persistence must fail the turn and must not trigger a second cleanup attempt.
test("rejects unlisted calls and invalid arguments, and propagates persistence failure once", async () => {
  const paths = await fixture();
  const execute = vi.fn(async () => ({ ok: true }));
  const finalize = vi.fn(async () => { throw new Error("Persistence acknowledgement failed"); });
  let round = 0;
  const { server, threadId } = await start({ ...paths, finalizeWorkTurn: finalize,
    embedding: { allowedTools: ["lookup_fixture"], authorizeTool: async () => {},
      resolveTools: async () => [{ name: "lookup_fixture", version: "1", inputSchema: argsSchema, execute }] },
    streamOpenPondHostedChatTurn: async function* () {
      round++;
      if (round === 1) yield call("schedule_work", {});
      else if (round === 2) yield call("lookup_fixture", { week: "bad" });
      else yield { type: "text_delta", raw: null, text: "No data available." };
      yield { type: "finish", raw: null, finishReason: round < 3 ? "tool_calls" : "stop" };
    },
  });
  expect(await server.runtime.turnStart({ threadId, input: { prompt: "Run fixture" } })).toMatchObject({ turn: { status: "failed" } });
  expect(execute).not.toHaveBeenCalled();
  expect(finalize).toHaveBeenCalledTimes(1);
});

// Regression boundary: a slow or overproducing application handler cannot hold the
// runtime indefinitely or send an unbounded payload to the model.
test.each(["timeout", "output limit"])("bounds custom tool %s", async kind => {
  const paths = await fixture(50);
  let handlerSignal: AbortSignal | undefined;
  let round = 0;
  const { server, threadId } = await start({ ...paths,
    embedding: { allowedTools: ["lookup_fixture"], maxToolOutputBytes: 128, authorizeTool: async () => {},
      resolveTools: async () => [{ name: "lookup_fixture", version: "1", inputSchema: argsSchema,
        execute: async ({ signal }) => {
          handlerSignal = signal;
          return kind === "timeout" ? new Promise<Record<string, unknown>>(() => {}) : { secret: "x".repeat(1_024) };
        } }],
    },
    streamOpenPondHostedChatTurn: async function* (request) {
      if (++round === 1) yield call("lookup_fixture", { week: 7 });
      else {
        expect(JSON.stringify(request.messages)).not.toContain("x".repeat(1_024));
        expect(JSON.stringify(request.messages)).toMatch(kind === "timeout" ? /timeout/i : /exceeds limit/);
        yield { type: "text_delta", raw: null, text: "The tool did not complete." };
      }
      yield { type: "finish", raw: null, finishReason: round === 1 ? "tool_calls" : "stop" };
    },
  });
  expect(await server.runtime.turnStart({ threadId, input: { prompt: "Run fixture" } }))
    .toMatchObject({ turn: { status: "completed" } });
  if (kind === "timeout") expect(handlerSignal?.aborted).toBe(true);
});

// A deployment cannot silently mutate the trusted release used by an existing home.
test("rejects changed bootstrap source and leaves the runtime home reopenable", async () => {
  const paths = await fixture();
  const options: OpenPondAppServerOptions = { ...paths, embedding: {
    allowedTools: [], authorizeTool: async () => {},
  }, streamOpenPondHostedChatTurn: async function* () {} };
  const server = await createOpenPondAppServer(options);
  await server.close();
  const manifestPath = path.join(paths.harness.sourceDirectory, "harness.json");
  const original = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(original);
  manifest.toolDeclarations[0].description = "Changed declaration";
  await writeFile(manifestPath, JSON.stringify(manifest));
  await expect(createOpenPondAppServer(options)).rejects.toThrow(/source changed/);
  await writeFile(manifestPath, original);
  const reopened = await createOpenPondAppServer(options);
  await reopened.close();
});
