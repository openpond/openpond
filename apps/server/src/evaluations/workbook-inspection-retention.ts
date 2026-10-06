import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, open, link, unlink, readFile } from "node:fs/promises";
import { contentHash } from "@openpond/harness";

/** Link a fully written immutable snapshot into place. A crash or concurrent
 * rescore must never leave a partial file at the content-addressed identity. */
export async function retainWorkbookInspection(
  storeDir: string,
  hash: string,
  serialized: string,
): Promise<void> {
  const directory = path.join(storeDir, "evaluation-artifact-inspections");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = path.join(directory, `${hash}.json`);
  const temporary = path.join(directory, `.inspection-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(serialized);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(temporary, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (contentHash(JSON.parse(await readFile(destination, "utf8"))) !== hash)
        throw new Error(
          "The retained workbook inspection differs from its immutable identity.",
        );
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
