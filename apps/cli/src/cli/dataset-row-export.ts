import { createHash } from "node:crypto";
import { link, lstat, mkdtemp, open, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { OpenPondDatasetWorkspaceClient } from "openpond-sdk/dataset-workspaces";

type RowOptions = NonNullable<Parameters<OpenPondDatasetWorkspaceClient["versionRows"]>[2]>;

export async function exportPublishedDatasetRows(
  client: OpenPondDatasetWorkspaceClient,
  input: { datasetId: string; revision: number; outputFile: string; query: Omit<RowOptions, "cursor" | "signal"> },
) {
  const outputFile = resolve(input.outputFile);
  try {
    await lstat(outputFile);
    throw new Error("The export file already exists. Choose a new path.");
  } catch (error) {
    if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const directory = await mkdtemp(join(dirname(outputFile), ".openpond-dataset-export-"));
  const partial = join(directory, "rows.ndjson");
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("Dataset export was interrupted."));
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);

  try {
    const { datasetId, revision, query } = input;
    const signal = () => AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]);
    const manifest = await client.versionManifest(datasetId, revision, signal());
    const splits = [...new Set(query.splits)];
    const splitTotal = splits.length
      ? splits.reduce((sum, split) => sum + manifest.splitCounts[split], 0)
      : manifest.acceptedRows;
    const digest = createHash("sha256");
    let total: number | undefined;
    let cursor: string | undefined;
    let exportedRows = 0;
    const handle = await open(partial, "wx", 0o600);
    try {
      do {
        const page = await client.versionRows(datasetId, revision, { ...query, cursor, signal: signal() });
        total ??= page.total;
        if (page.indexHash !== manifest.indexHash || page.total !== total || total > splitTotal ||
          (!query.fileId && total !== splitTotal) || exportedRows + page.rows.length > total)
          throw new Error("The dataset index or exported selection changed.");
        const bytes = page.rows.map(row => JSON.stringify(row) + "\n").join("");
        await handle.writeFile(bytes);
        digest.update(bytes);
        exportedRows += page.rows.length;
        cursor = page.nextCursor ?? undefined;
        if (cursor && exportedRows === total) throw new Error("The dataset export cursor exceeded its row count.");
      } while (cursor);
      if (exportedRows !== total) throw new Error("The dataset export ended before all selected rows were read.");
      await handle.sync();
    } finally {
      await handle.close();
    }
    controller.signal.throwIfAborted();
    // Linking within the destination filesystem atomically creates the final
    // path and cannot replace a file created by another process meanwhile.
    await link(partial, outputFile);
    return {
      datasetId, revision, indexHash: manifest.indexHash, outputFile, exportedRows,
      sha256: digest.digest("hex"),
    };
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
    await rm(directory, { recursive: true, force: true });
  }
}
