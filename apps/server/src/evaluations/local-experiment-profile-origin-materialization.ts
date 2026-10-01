import { createHash } from "node:crypto";
import {
  mkdir,
  writeFile,
  rm,
  rename,
  readdir,
  readFile,
  lstat,
} from "node:fs/promises";
import { contentHash } from "@openpond/harness";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";

const fileSchema = z.object({
  path: z.string(),
  type: z.enum(["file", "directory"]),
  sizeBytes: z.number().nullable(),
  oid: z.string().nullable(),
  mode: z.string().nullable(),
});
const responseSchema = z.object({
  commitSha: z.string(),
  entries: z.array(fileSchema).max(5000),
  truncated: z.boolean(),
  selectedFile: z
    .object({
      path: z.string(),
      sizeBytes: z.number(),
      contents: z.string().nullable(),
      encoding: z.literal("utf8").nullable(),
      isBinary: z.boolean(),
      truncated: z.boolean(),
    })
    .nullable(),
});
export type ProfileOriginReader = (query: {
  branch: string;
  path?: string;
  maxEntries: number;
}) => Promise<unknown>;
/** Only complete ordinary committed files can enter the native compiler. Never
 * interpret a symlink, partial text preview, or binary omission as source. */
export async function materializeProfileOrigin(input: {
  root: string;
  revision: string;
  read: ProfileOriginReader;
}) {
  const tree = responseSchema.parse(
    await input.read({
      branch: input.revision,
      path: "__openpond_profile_origin_tree_only__",
      maxEntries: 5000,
    }),
  );
  if (tree.commitSha !== input.revision || tree.truncated)
    throw new Error("Profile origin tree is incomplete or changed its commit.");
  const files = tree.entries.filter((entry) => entry.type === "file");
  if (!files.length || files.length > 5000)
    throw new Error("Profile origin has no complete bounded source tree.");
  let total = 0;
  const seen = new Set<string>();
  for (const file of files) {
    if (
      file.path.startsWith("/") ||
      file.path.includes("\\") ||
      file.path
        .split("/")
        .some((part) => !part || part === "." || part === "..") ||
      seen.has(file.path) ||
      !["100644", "100755"].includes(file.mode ?? "") ||
      !Number.isSafeInteger(file.sizeBytes) ||
      file.sizeBytes! < 0 ||
      file.sizeBytes! > 2_000_000 ||
      !file.oid?.match(/^[a-f0-9]{40}$/)
    )
      throw new Error(
        "Profile origin contains unsupported paths, modes, or bytes.",
      );
    if (
      file.path
        .split("/")
        .some(
          (part) =>
            part === ".git" ||
            part.startsWith(".env") ||
            /\.(sql|sqlite|sqlite3|db)$/i.test(part),
        )
    )
      throw new Error(
        "Profile origin contains an unsupported secret or database source path.",
      );
    seen.add(file.path);
    total += file.sizeBytes!;
  }
  if (total > 32_000_000)
    throw new Error("Profile origin exceeds the bounded source size.");
  const temporary = `${input.root}.partial-${randomUUID()}`;
  await mkdir(temporary, { recursive: true, mode: 0o700 });
  try {
    const hashes: Array<{ path: string; oid: string; sizeBytes: number }> = [];
    // Deliberately bounded sequential reads; each is reauthorized by the facade.
    for (const entry of files) {
      const response = responseSchema.parse(
        await input.read({
          branch: input.revision,
          path: entry.path,
          maxEntries: 5000,
        }),
      );
      const file = response.selectedFile;
      if (
        response.commitSha !== input.revision ||
        !file ||
        file.path !== entry.path ||
        file.isBinary ||
        file.truncated ||
        file.encoding !== "utf8" ||
        file.contents === null
      )
        throw new Error(
          "Profile origin cannot supply complete exact source bytes.",
        );
      const bytes = Buffer.from(file.contents, "utf8");
      const oid = createHash("sha1")
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest("hex");
      if (
        bytes.length !== entry.sizeBytes ||
        file.sizeBytes !== entry.sizeBytes ||
        oid !== entry.oid
      )
        throw new Error(
          "Profile origin file differs from its committed Git blob.",
        );
      const destination = path.join(temporary, ...entry.path.split("/"));
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, bytes, { mode: 0o600, flag: "wx" });
      hashes.push({ path: entry.path, oid, sizeBytes: bytes.length });
    }
    await mkdir(path.dirname(input.root), { recursive: true, mode: 0o700 });
    await rename(temporary, input.root);
    return hashes.sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

/** Verify the complete materialized tree, including compiler-unused files. */
export async function profileOriginFilesHash(root: string): Promise<string> {
  const files: Array<{ path: string; oid: string; sizeBytes: number }> = [];
  let total = 0;
  async function visit(directory: string, prefix: string) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${item.name}` : item.name,
        absolute = path.join(directory, item.name);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink())
        throw new Error("Profile origin cache contains a symlink.");
      if (stat.isDirectory()) {
        await visit(absolute, relative);
        continue;
      }
      if (
        !stat.isFile() ||
        stat.size > 2_000_000 ||
        files.length >= 5000 ||
        (total += stat.size) > 32_000_000
      )
        throw new Error("Profile origin cache exceeds its bounds.");
      const bytes = await readFile(absolute);
      files.push({
        path: relative,
        oid: createHash("sha1")
          .update(`blob ${bytes.length}\0`)
          .update(bytes)
          .digest("hex"),
        sizeBytes: bytes.length,
      });
    }
  }
  await visit(root, "");
  return contentHash(
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  );
}
