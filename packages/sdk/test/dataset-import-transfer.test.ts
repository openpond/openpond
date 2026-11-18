import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { expect, test } from "vitest";
import { contentHash } from "@openpond/harness";
import { OpenPondDatasetImportClient, OpenPondDatasetWorkspaceClient } from "../src/dataset-workspaces.js";
import { createTasksetDraft, createTasksetDraftWorkspace } from "../src/taskset-drafts.js";

async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function server(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>) {
  const failures: unknown[] = [];
  const instance = createServer((request, response) => {
    void Promise.resolve().then(() => handler(request, response)).catch(error => {
      failures.push(error);
      response.writeHead(500).end();
    });
  });
  instance.listen(0, "127.0.0.1");
  await once(instance, "listening");
  const address = instance.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind TCP.");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      instance.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        instance.close(error => error ? reject(error) : resolve()));
      expect(failures).toEqual([]);
    },
  };
}

test("resumes after a lost part acknowledgement without forwarding API credentials to storage", async () => {
  const source = new Blob(["aaaa", "bb"]);
  const sha256 = createHash("sha256").update("aaaabb").digest("hex");
  const uploaded = [{ partNumber: 1, sizeBytes: 4, etag: '"one"' }];
  let apiRequests = 0;
  let puts = 0;
  let completeCalls = 0;
  const objects = await server(async (request, response) => {
    expect(request.method).toBe("PUT");
    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers["x-openpond-team-id"]).toBeUndefined();
    expect(request.headers.cookie).toBeUndefined();
    expect(request.headers["content-length"]).toBe("2");
    expect((await body(request)).toString()).toBe("bb");
    puts++;
    uploaded.push({ partNumber: 2, sizeBytes: 2, etag: '"two"' });
    // The transfer committed even though the response failed.
    response.writeHead(503).end();
  });
  const file = { fileId: "file-1", relativePath: "examples.jsonl", state: "uploading", sizeBytes: 6, partSize: 4, failureCode: null, object: null };
  const api = await server(async (request, response) => {
    expect(request.headers.authorization).toBe("Bearer synthetic-fixture");
    expect(request.headers["x-openpond-team-id"]).toBe("team-fixture");
    apiRequests++;
    const result = (value: unknown) => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
    if (request.method === "GET") {
      result({ ...file, parts: uploaded, nextCursor: null });
    } else if (request.url?.endsWith("/parts")) {
      expect(JSON.parse((await body(request)).toString())).toEqual({ partNumbers: [2] });
      result({ fileId: file.fileId, parts: [{ partNumber: 2, sizeBytes: 2, url: `${objects.origin}/part?signature=synthetic`, headers: { "content-length": "2" } }] });
    } else if (request.url?.endsWith("/complete")) {
      completeCalls++;
      expect(JSON.parse((await body(request)).toString())).toEqual({
        operationId: "complete-fixture", sha256,
        parts: [{ partNumber: 1, etag: '"one"' }, { partNumber: 2, etag: '"two"' }],
      });
      result({ ...file, state: "queued" });
    } else {
      response.writeHead(404).end();
    }
  });
  try {
    const client = () => new OpenPondDatasetImportClient({
      apiKey: "synthetic-fixture", teamId: "team-fixture", baseUrl: api.origin,
    });
    const reads: Array<[number, number]> = [];
    const fileSource = { sha256, sizeBytes: source.size, read(start: number, end: number) {
      reads.push([start, end]);
      return source.slice(start, end);
    } };
    const options = { operationId: "complete-fixture" };
    await expect(client().uploadFile("import-1", file.fileId, fileSource, options))
      .rejects.toMatchObject({ code: "dataset_storage_transfer_failed", retryable: true });
    const resumed = await client().uploadFile("import-1", file.fileId, fileSource, options);
    expect(resumed.state).toBe("queued");
    expect(reads).toEqual([[4, 6]]);
    expect(puts).toBe(1);
    expect(completeCalls).toBe(1);
    expect(apiRequests).toBe(4);
  } finally {
    await Promise.all([api.close(), objects.close()]);
  }
});

test("retains the mapping and prepared index through the draft receipt", async () => {
  const mapping = {
    operationId: "mapping-fixture",
    expectedRevision: 0,
    groups: [{ kind: "sources" as const, fileIds: ["file-1"] }],
  };
  const mappingHash = contentHash({ version: "openpond.datasetImportMapping.v1", groups: mapping.groups });
  const mappingReceipt = { importId: "import-1", revision: 1, mappingHash, groups: mapping.groups };
  const prepared = {
    importId: "import-1", materializationId: "prepare-1", mappingRevision: 1, mappingHash,
    state: "queued", acceptedRows: 0, rejectedRows: 0, shardCount: 0,
    splitCounts: null, indexHash: null, failureCode: null,
  };
  const finishRequest = {
    operationId: "save-fixture", name: "Verified import", ownerScope: "personal" as const,
    materializationId: prepared.materializationId, mappingRevision: 1, mappingHash,
    indexHash: contentHash("fixture-index"),
  };
  const draft = {
    importId: prepared.importId, datasetId: "draft-1", revision: 1,
    workspaceHash: contentHash("fixture-workspace"), materializationId: prepared.materializationId,
    mappingRevision: 1, mappingHash, indexHash: finishRequest.indexHash,
    acceptedRows: 0, rejectedRows: 0, shardCount: 0,
  };
  let sendStaleDraft = false;
  const versionPin = {
    teamId: "team-fixture", datasetId: draft.datasetId, revision: 1, workspaceHash: draft.workspaceHash,
    packageHash: contentHash("fixture-version"), indexHash: draft.indexHash,
    release: { id: draft.datasetId, revision: 2, contentHash: contentHash("fixture-version") },
  };
  const publishedDraft = createTasksetDraft({
    profileId: versionPin.teamId, id: draft.datasetId, name: "Fixture", now: "2026-01-01T00:00:00.000Z",
  });
  const versionWorkspace = createTasksetDraftWorkspace({
    schemaVersion: "openpond.tasksetDraftWorkspace.v1", files: [], draft: {
      ...publishedDraft, status: "published", publishedTasksetRef: versionPin.release, revision: 2,
      metadata: { hostedImport: { indexHash: draft.indexHash } },
    },
  });
  const row = (ordinal: number) => ({
    ordinal,
    id: createHash("sha256").update(String(ordinal)).digest("hex"),
    values: { input: { text: String(ordinal) } },
  });
  const api = await server(async (request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1");
    const reply = (value: unknown) => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
    if (url.pathname === "/v1/dataset-imports/import-1/mapping") {
      if (request.method === "PUT") expect(JSON.parse((await body(request)).toString())).toEqual(mapping);
      else expect(request.method).toBe("GET");
      reply(mappingReceipt);
      return;
    }
    if (url.pathname === "/v1/dataset-imports/import-1/materializations") {
      expect(request.method).toBe("POST");
      expect(JSON.parse((await body(request)).toString())).toEqual({
        operationId: "prepare-fixture", mappingRevision: 1, mappingHash, allowRejectedRows: false,
      });
      reply(prepared);
      return;
    }
    if (url.pathname === "/v1/dataset-imports/import-1/materializations/prepare-1") {
      expect(request.method).toBe("GET");
      reply({
        ...prepared, state: "ready", splitCounts: { train: 0, validation: 0, test: 0, frozen_eval: 0 },
        indexHash: finishRequest.indexHash, shards: [], nextCursor: null,
      });
      return;
    }
    if (url.pathname === "/v1/dataset-imports/import-1/finish") {
      expect(request.method).toBe("POST");
      expect(JSON.parse((await body(request)).toString())).toEqual(finishRequest);
      reply(sendStaleDraft ? { ...draft, indexHash: contentHash("stale-index") } : draft);
      return;
    }
    if (url.pathname === "/v1/dataset-workspaces/draft-1/versions/validate") {
      expect(request.method).toBe("POST");
      expect(JSON.parse((await body(request)).toString())).toEqual({ expectedRevision: 1 });
      reply(versionPin);
      return;
    }
    if (url.pathname === "/v1/dataset-workspaces/draft-1/versions") {
      expect(request.method).toBe("POST");
      expect(JSON.parse((await body(request)).toString())).toEqual({
        operationId: "publish-fixture", expectedRevision: 1, workspaceHash: draft.workspaceHash,
        packageHash: versionPin.packageHash, indexHash: draft.indexHash,
      });
      reply({ schemaVersion: "openpond.datasetWorkspaceReceipt.v1", teamId: versionPin.teamId,
        datasetId: draft.datasetId, revision: 2, workspace: versionWorkspace,
        publication: { tasksetId: "taskset-fixture", release: versionPin.release, packageHash: versionPin.packageHash } });
      return;
    }
    if (url.pathname === "/v1/dataset-workspaces/draft-1/versions/2/manifest") {
      expect(request.method).toBe("GET");
      reply({ ...versionPin, revision: 2, draftRevision: 1, acceptedRows: 2, rejectedRows: 0,
        shardCount: 1, splitCounts: { train: 2, validation: 0, test: 0, frozen_eval: 0 },
        publishedAt: "2026-01-01T00:00:00.000Z" });
      return;
    }
    if (["/v1/dataset-workspaces/draft-1/rows", "/v1/dataset-workspaces/draft-1/versions/2/rows"].includes(url.pathname)) {
      expect(request.method).toBe("GET");
      const revision = url.pathname.includes("/versions/") ? 2 : 1;
      expect(url.searchParams.get("revision")).toBe(String(revision));
      expect(url.searchParams.get("limit")).toBe("1");
      expect(url.searchParams.get("split")).toBe("train");
      const after = url.searchParams.get("cursor");
      expect(after === null || after === "after-first").toBe(true);
      reply({ teamId: "team-fixture", datasetId: draft.datasetId, revision, indexHash: draft.indexHash,
        total: 2, rows: [{ id: contentHash(after ? "second" : "first"), split: "train",
          input: { prompt: after ? "second" : "first" }, policyVisibleContext: {},
          source: { fileId: "file-1", ordinal: after ? 2 : 1 } }], nextCursor: after ? null : "after-first" });
      return;
    }
    expect(request.method).toBe("GET");
    expect(url.pathname).toBe("/v1/dataset-imports/import-1/preview");
    expect(url.searchParams.get("fileId")).toBe("file-1");
    expect(url.searchParams.get("limit")).toBe("1");
    const after = url.searchParams.get("after");
    if (after) {
      expect(url.searchParams.get("revision")).toBe("1");
      expect(url.searchParams.get("mappingRevision")).toBe("1");
    }
    const page = {
      importId: "import-1", fileId: "file-1", relativePath: "examples.jsonl",
      sizeBytes: 1024, uploadState: "verified", revision: 1,
      state: after ? "ready" : "inspecting", format: "jsonl",
      scannedBytes: after ? 1024 : 512, acceptedRows: 2, rejectedRows: 1,
      totalRows: after ? 3 : null, provisional: !after, previewedRows: 2, failureCode: null,
      ...(after && { mappingRevision: 1, mappingHash }),
      rows: [after ? { ...row(3), projection: { state: "source" } } : row(1)],
      nextCursor: after ? null : "1",
    };
    reply(page);
  });
  try {
    const client = new OpenPondDatasetImportClient({ apiKey: "fixture", teamId: "team-fixture", baseUrl: api.origin });
    const first = await client.preview("import-1", { fileId: "file-1", limit: 1 });
    expect(first.provisional).toBe(true);
    const saved = await client.saveMapping("import-1", mapping);
    expect(await client.mapping("import-1")).toEqual(saved);
    const last = await client.preview("import-1", {
      fileId: "file-1", limit: 1, revision: first.revision!, after: first.nextCursor!, mappingRevision: saved.revision,
    });
    expect(last.totalRows).toBe(3);
    expect(last.rows[0]?.values).toEqual({ input: { text: "3" } });
    expect(last.rows[0]?.projection).toEqual({ state: "source" });
    const job = await client.materialize("import-1", {
      operationId: "prepare-fixture", mappingRevision: saved.revision, mappingHash: saved.mappingHash,
    });
    expect(job.state).toBe("queued");
    expect(await client.materialization("import-1", job.materializationId)).toMatchObject({
      state: "ready", mappingHash, shardCount: 0, shards: [],
    });
    expect(await client.finish("import-1", finishRequest)).toEqual(draft);
    const workspaces = new OpenPondDatasetWorkspaceClient({ apiKey: "fixture", teamId: "team-fixture", baseUrl: api.origin });
    const rows = { revision: draft.revision, limit: 1, splits: ["train" as const] };
    const firstPage = await workspaces.rows(draft.datasetId, rows);
    const lastPage = await workspaces.rows(draft.datasetId, { ...rows, cursor: firstPage.nextCursor! });
    expect(firstPage.indexHash).toBe(draft.indexHash);
    expect(lastPage.rows.map(({ source }) => source.ordinal)).toEqual([2]);
    expect(lastPage.nextCursor).toBe(null);
    const validated = await workspaces.validateVersion(draft.datasetId, 1);
    const created = await workspaces.createVersion(draft.datasetId, { operationId: "publish-fixture", expectedRevision: 1,
      workspaceHash: validated.workspaceHash, indexHash: validated.indexHash, packageHash: validated.packageHash });
    expect(created.publication?.release).toEqual(validated.release);
    expect((await workspaces.versionManifest(draft.datasetId, created.revision)).indexHash).toBe(draft.indexHash);
    const versionRows = await workspaces.versionRows(draft.datasetId, created.revision, { limit: 1, splits: ["train"] });
    expect(versionRows.revision).toBe(2);
    sendStaleDraft = true;
    await expect(client.finish("import-1", finishRequest)).rejects.toThrow("Dataset draft response identity mismatch");
  } finally {
    await api.close();
  }
});
