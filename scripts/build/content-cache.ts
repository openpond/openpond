import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export async function digest(paths: string[]): Promise<string> {
  const hash = createHash("sha256");
  async function visit(file: string): Promise<void> {
    hash.update(file).update("\0");
    let stat;
    try {
      stat = await fs.stat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      hash.update("missing\0");
      return;
    }
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(file)).sort()) await visit(path.join(file, name));
    } else {
      const bytes = await fs.readFile(file);
      hash.update(`${bytes.length}\0`).update(bytes);
    }
  }
  for (const file of paths) await visit(file);
  return hash.digest("hex");
}

export async function ensureDevBuild(options: {
  inputs: string[];
  outputs: string[];
  cacheFile: string;
  build: () => void | Promise<void>;
}): Promise<"built" | "cached"> {
  const inputs = await digest(options.inputs);
  const outputs = await digest(options.outputs);
  const receipt = JSON.stringify({ inputs, outputs, node: process.version });
  if ((await fs.readFile(options.cacheFile, "utf8").catch(() => "")) === receipt) return "cached";

  // A failed or interrupted build must never leave a valid receipt behind.
  await fs.rm(options.cacheFile, { force: true });
  await options.build();
  if ((await digest(options.inputs)) !== inputs) return "built";
  await fs.mkdir(path.dirname(options.cacheFile), { recursive: true });
  await fs.writeFile(
    options.cacheFile,
    JSON.stringify({ inputs, outputs: await digest(options.outputs), node: process.version }),
  );
  return "built";
}
