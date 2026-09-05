import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";

export async function digestFile(file: string): Promise<string> {
  const stat = await fs.lstat(file), hash = createHash("sha256");
  if (stat.isSymbolicLink()) return hash.update(`symlink:${await fs.readlink(file)}`).digest("hex");
  if (!stat.isFile()) throw new Error(`Unsupported migration object: ${file}`);
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
