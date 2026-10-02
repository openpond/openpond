import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
export function collectorDirectory(
  home = process.env.OPENPOND_HOME || join(homedir(), ".openpond"),
) {
  return resolve(home, "conversation-importer");
}
export async function collectorMachineId(directory = collectorDirectory()) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, "machine-id");
  try {
    const handle = await open(file, "wx", 0o600);
    try {
      await handle.writeFile(randomUUID());
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const id = (await readFile(file, "utf8")).trim();
  if (!/^[a-f0-9-]{36}$/u.test(id))
    throw new Error(
      "Collector machine identity is invalid; restore its retained state.",
    );
  return id;
}
