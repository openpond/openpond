import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { expect, test } from "vitest";
import { OpenPondDatasetImportClient } from "../src/dataset-workspaces.js";

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

test("retains the inspection revision across bounded preview pages", async () => {
  const row = (ordinal: number) => ({
    ordinal,
    id: createHash("sha256").update(String(ordinal)).digest("hex"),
    values: { input: { text: String(ordinal) } },
  });
  const api = await server((request, response) => {
    expect(request.method).toBe("GET");
    const url = new URL(request.url!, "http://127.0.0.1");
    expect(url.pathname).toBe("/v1/dataset-imports/import-1/preview");
    expect(url.searchParams.get("fileId")).toBe("file-1");
    expect(url.searchParams.get("limit")).toBe("1");
    const after = url.searchParams.get("after");
    if (after) expect(url.searchParams.get("revision")).toBe("1");
    const page = {
      importId: "import-1", fileId: "file-1", relativePath: "examples.jsonl",
      sizeBytes: 1024, uploadState: "verified", revision: 1,
      state: after ? "ready" : "inspecting", format: "jsonl",
      scannedBytes: after ? 1024 : 512, acceptedRows: 2, rejectedRows: 1,
      totalRows: after ? 3 : null, provisional: !after, previewedRows: 2, failureCode: null,
      rows: [row(after ? 3 : 1)], nextCursor: after ? null : "1",
    };
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(page));
  });
  try {
    const client = new OpenPondDatasetImportClient({ apiKey: "fixture", teamId: "team-fixture", baseUrl: api.origin });
    const first = await client.preview("import-1", { fileId: "file-1", limit: 1 });
    expect(first.provisional).toBe(true);
    const last = await client.preview("import-1", {
      fileId: "file-1", limit: 1, revision: first.revision!, after: first.nextCursor!,
    });
    expect(last.totalRows).toBe(3);
    expect(last.rows[0]?.values).toEqual({ input: { text: "3" } });
  } finally {
    await api.close();
  }
});
