import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { expect, test } from "vitest";
import { OpenPondDatasetWorkspaceClient } from "openpond-sdk/dataset-workspaces";
import { runDatasetVersionCommand } from "../src/cli/datasets-versions";

test("exports the exact filtered published rows and keeps partial bytes out of the destination", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dataset-export-proof-"));
  const indexHash = "a".repeat(64);
  const releaseHash = "b".repeat(64);
  const picked = [1, 2, 3].map((ordinal) => ({
    id: createHash("sha256").update(String(ordinal)).digest("hex"),
    split: "train",
    input: { question: `Example ${ordinal}` },
    policyVisibleContext: {},
    source: { fileId: "fixture-file", ordinal },
  }));
  let changeIndex = false;
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost");
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/v1/dataset-workspaces/fixture/versions/2/manifest") {
      response.end(JSON.stringify({
        teamId: "fixture-team", datasetId: "fixture", revision: 2, draftRevision: 1,
        workspaceHash: "c".repeat(64), indexHash, packageHash: releaseHash,
        release: { id: "fixture", revision: 2, contentHash: releaseHash },
        acceptedRows: 5, rejectedRows: 0, shardCount: 2,
        splitCounts: { train: 4, validation: 1, test: 0, frozen_eval: 0 },
        publishedAt: "2026-01-01T00:00:00.000Z",
      }));
      return;
    }
    if (url.pathname !== "/v1/dataset-workspaces/fixture/versions/2/rows" ||
      url.searchParams.get("split") !== "train" || url.searchParams.get("fileId") !== "fixture-file") {
      response.statusCode = 400;
      response.end(JSON.stringify({ code: "invalid_selection" }));
      return;
    }
    const cursor = url.searchParams.get("cursor");
    response.end(JSON.stringify({
      teamId: "fixture-team", datasetId: "fixture", revision: 2,
      indexHash: cursor && changeIndex ? "d".repeat(64) : indexHash,
      total: picked.length, rows: cursor ? picked.slice(2) : picked.slice(0, 2),
      nextCursor: cursor ? null : "next-page",
    }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const client = new OpenPondDatasetWorkspaceClient({
    teamId: "fixture-team", apiKey: "fixture", baseUrl: `http://127.0.0.1:${address.port}`,
  });
  const exportTo = (outputFile: string) => runDatasetVersionCommand(client, "export-rows", "fixture", {
    versionRevision: "2", split: "train", fileId: "fixture-file", outputFile,
  });
  try {
    const path = join(directory, "selected.ndjson");
    const result = await exportTo(path);
    const bytes = await readFile(path, "utf8");
    expect(bytes).toBe(picked.map(row => JSON.stringify(row) + "\n").join(""));
    expect(result).toMatchObject({
      revision: 2, indexHash, exportedRows: 3,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    await expect(exportTo(path)).rejects.toThrow("already exists");

    changeIndex = true;
    await expect(exportTo(join(directory, "inconsistent.ndjson"))).rejects.toThrow("index or exported selection changed");
    expect(await readdir(directory)).toEqual(["selected.ndjson"]);
    expect(await readFile(path, "utf8")).toBe(bytes);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
