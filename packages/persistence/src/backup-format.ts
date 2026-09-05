import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, createGunzip } from "node:zlib";
import { z } from "zod";
import { digestFile } from "./file-integrity.js";
import { privateDirectory } from "./private-file.js";

const MAGIC = Buffer.from("OPBK1\0");
const safePath = z.string().min(1).refine((value) => !path.isAbsolute(value) && !/^[A-Za-z]:/.test(value) && !value.split(/[\\/]/).some((part) => !part || part === "." || part === ".."));
const entrySchema = z.strictObject({ path: safePath, sizeBytes: z.number().safe().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/), executable: z.boolean(), link: z.string().optional() });
export const BackupManifestSchema = z.strictObject({ schemaVersion: z.literal("openpond.recoveryBackup.v1"), originalHome: z.string(), createdAt: z.string().datetime(), entries: z.array(entrySchema).max(500_000), externalRoots: z.array(z.strictObject({ path: z.string(), available: z.boolean(), included: z.literal(false) })), browserIncluded: z.boolean() });
export type BackupManifest = z.infer<typeof BackupManifestSchema>;
export async function encryptBackup(stage: string, output: string, key: Uint8Array, manifest: BackupManifest): Promise<void> {
  if (key.byteLength !== 32) throw new Error("A backup encryption key must contain exactly 32 bytes.");
  const serialized = Buffer.from(JSON.stringify(BackupManifestSchema.parse(manifest)));
  if (serialized.length > 32 * 1024 * 1024) throw new Error("Backup manifest exceeds the supported size.");
  const length = Buffer.alloc(4); length.writeUInt32BE(serialized.length);
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(MAGIC);
  const file = await fs.open(output, "wx", 0o600);
  try { await file.write(Buffer.concat([MAGIC, iv])); await file.sync(); } finally { await file.close(); }
  async function* archive() {
    yield length; yield serialized;
    for (const entry of manifest.entries) if (entry.link === undefined) {
      for await (const chunk of createReadStream(path.join(stage, entry.path))) yield chunk as Buffer;
    }
  }
  await pipeline(Readable.from(archive()), createGzip(), cipher, createWriteStream(output, { flags: "a" }));
  const finished = await fs.open(output, "a");
  try { await finished.write(cipher.getAuthTag()); await finished.sync(); } finally { await finished.close(); }
}

/** Authenticated plaintext is extracted only into a private, unactivated staging directory. */
export async function decryptBackup(input: string, stage: string, key: Uint8Array): Promise<BackupManifest> {
  if (key.byteLength !== 32) throw new Error("A backup encryption key must contain exactly 32 bytes.");
  const size = (await fs.stat(input)).size, headerLength = MAGIC.length + 12;
  if (size < headerLength + 16) throw new Error("Truncated recovery backup.");
  const file = await fs.open(input, "r"), header = Buffer.alloc(headerLength), tag = Buffer.alloc(16);
  try { await file.read(header, 0, header.length, 0); await file.read(tag, 0, 16, size - 16); } finally { await file.close(); }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("Unsupported recovery backup format.");
  const decipher = createDecipheriv("aes-256-gcm", key, header.subarray(MAGIC.length));
  decipher.setAAD(MAGIC); decipher.setAuthTag(tag);
  const source = createReadStream(input, { start: headerLength, end: size - 17 });
  const uncompressed = createGunzip();
  const transfer = pipeline(source, decipher, uncompressed);
  // Always observe pipeline failure while the bounded reader consumes its output.
  void transfer.catch(() => undefined);
  const iterator = uncompressed[Symbol.asyncIterator]();
  let buffered = Buffer.alloc(0), offset = 0;
  async function take(size: number): Promise<Buffer> {
    const output = Buffer.alloc(size); let written = 0;
    while (written < size) {
      if (offset >= buffered.length) {
        const next = await iterator.next();
        if (next.done) throw new Error("Truncated recovery object.");
        buffered = Buffer.from(next.value); offset = 0;
      }
      const bytes = Math.min(size - written, buffered.length - offset);
      buffered.copy(output, written, offset, offset + bytes); offset += bytes; written += bytes;
    }
    return output;
  }
  try {
    const manifestLength = (await take(4)).readUInt32BE();
    if (manifestLength > 32 * 1024 * 1024) throw new Error("Invalid recovery manifest size.");
    const manifest = BackupManifestSchema.parse(JSON.parse((await take(manifestLength)).toString("utf8")));
    if (new Set(manifest.entries.map((entry) => entry.path)).size !== manifest.entries.length) throw new Error("Duplicate recovery object paths.");
    for (const entry of manifest.entries) {
      const target = path.join(stage, entry.path);
      if (/^(runtime|backups)([\\/]|$)/.test(entry.path) || entry.path.endsWith("-wal") || entry.path.endsWith("-shm")) throw new Error("Recovery manifest contains an unsupported runtime object.");
      await privateDirectory(path.dirname(target));
      if (entry.link !== undefined) {
        if (path.isAbsolute(entry.link) || !within(path.resolve(path.dirname(target), entry.link), stage)) throw new Error("Recovery symlink leaves the backup root.");
        await fs.symlink(entry.link, target);
      } else {
        const handle = await fs.open(target, "wx", entry.executable ? 0o700 : 0o600);
        try {
          for (let remaining = entry.sizeBytes; remaining > 0;) {
            const chunk = await take(Math.min(1024 * 1024, remaining));
            await handle.writeFile(chunk); remaining -= chunk.length;
          }
          await handle.sync();
        } finally { await handle.close(); }
      }
      if (await digestFile(target) !== entry.sha256) throw new Error("Recovery object failed its checksum.");
    }
    if (offset < buffered.length || !(await iterator.next()).done) throw new Error("Unexpected trailing recovery data.");
    await transfer;
    return manifest;
  } catch (error) { source.destroy(); decipher.destroy(); uncompressed.destroy(); await transfer.catch(() => undefined); throw error; }
}
export function within(file: string, root: string): boolean { const relative = path.relative(path.resolve(root), path.resolve(file)); return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
