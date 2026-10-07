import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, open } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { z } from "zod";

const MAGIC = Buffer.from("OPENPOND_TVC_V1!");
const section = z.object({ offset: z.number().int().nonnegative(), bytes: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const manifestSchema = z.object({
  schema: z.literal(1), engine: section, model: section,
  llamaCommit: z.literal("5ad1c5da0ad7f6176256b823925aad19134f0263"),
}).strict();
export type EmbeddedManifest = z.infer<typeof manifestSchema>;

/** The deployment digest binds this trailer and both payloads to the approved pivot. */
export async function readEmbeddedManifest(executable: string): Promise<EmbeddedManifest> {
  const file = await open(executable, "r");
  try {
    const { size } = await file.stat();
    if (size < 24 || size > 768 * 1024 * 1024) throw new Error("Invalid embedded package size");
    const footer = Buffer.alloc(24);
    if ((await file.read(footer, 0, 24, size - 24)).bytesRead !== 24 || !footer.subarray(0, 16).equals(MAGIC))
      throw new Error("Embedded model package is missing");
    const length = Number(footer.readBigUInt64LE(16));
    if (!Number.isSafeInteger(length) || length < 1 || length > 8192 || length > size - 24)
      throw new Error("Invalid embedded manifest length");
    const start = size - 24 - length;
    const bytes = Buffer.alloc(length);
    if ((await file.read(bytes, 0, length, start)).bytesRead !== length) throw new Error("Incomplete embedded manifest");
    const manifest = manifestSchema.parse(JSON.parse(bytes.toString("utf8")));
    const { engine, model } = manifest;
    if (engine.offset < 4096 || engine.bytes > 100 * 1024 * 1024 || engine.offset + engine.bytes > model.offset ||
        model.offset % 4096 !== 0 || model.offset + model.bytes !== start || model.bytes !== 105_454_432 ||
        model.sha256 !== "2e8040ceae7815abe0dcb3540b9995eaa1fa0d2ca9e797d0a635ae4433c68c2d")
      throw new Error("Invalid embedded payload boundaries or model identity");
    return manifest;
  } finally { await file.close(); }
}

export async function verifySection(executable: string, section: EmbeddedManifest["model"]): Promise<void> {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(executable, { start: section.offset, end: section.offset + section.bytes - 1, highWaterMark: 65536 })) hash.update(bytes);
  if (hash.digest("hex") !== section.sha256) throw new Error("Embedded payload digest mismatch");
}

export async function extractEngine(executable: string, manifest: EmbeddedManifest, target: string): Promise<void> {
  await verifySection(executable, manifest.engine);
  await pipeline(createReadStream(executable, { start: manifest.engine.offset, end: manifest.engine.offset + manifest.engine.bytes - 1, highWaterMark: 65536 }),
    createWriteStream(target, { flags: "wx", mode: 0o600 }));
  await chmod(target, 0o700);
}
