import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { extractEngine, readEmbeddedManifest, type EmbeddedManifest } from "./package.js";

// Failure story: malformed or corrupt appended bytes must never become an
// executable child, even when the surrounding ELF still starts successfully.
test("embedded package rejects overlapping sections and corrupt executable bytes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tvc-package-check-"));
  try {
    const executable = path.join(directory, "pivot");
    const engine = Buffer.from("synthetic engine bytes");
    const manifest: EmbeddedManifest = {
      schema: 1, llamaCommit: "5ad1c5da0ad7f6176256b823925aad19134f0263",
      engine: { offset: 4096, bytes: engine.length, sha256: createHash("sha256").update(engine).digest("hex") },
      model: { offset: 8192, bytes: 105454432, sha256: "2e8040ceae7815abe0dcb3540b9995eaa1fa0d2ca9e797d0a635ae4433c68c2d" },
    };
    const writePackage = async (value: EmbeddedManifest) => {
      const file = await open(executable, "w");
      try {
        await file.write(engine, 0, engine.length, 4096);
        const json = Buffer.from(JSON.stringify(value));
        const footer = Buffer.alloc(24);
        footer.write("OPENPOND_TVC_V1!"); footer.writeBigUInt64LE(BigInt(json.length), 16);
        await file.write(Buffer.concat([json, footer]), 0, json.length + footer.length, 8192 + 105454432);
      } finally { await file.close(); }
    };
    await writePackage(manifest);
    assert.deepEqual(await readEmbeddedManifest(executable), manifest);
    const target = path.join(directory, "engine");
    await extractEngine(executable, manifest, target);
    assert.deepEqual(await readFile(target), engine);
    await assert.rejects(extractEngine(executable, manifest, target), /EEXIST/);
    const file = await open(executable, "r+");
    try { await file.write(Buffer.from("!"), 0, 1, 4096); } finally { await file.close(); }
    await assert.rejects(extractEngine(executable, manifest, path.join(directory, "corrupt")), /digest mismatch/);
    await writePackage({ ...manifest, engine: { ...manifest.engine, bytes: 8192 } });
    await assert.rejects(readEmbeddedManifest(executable), /boundaries/);
    await writeFile(executable, "not an embedded package");
    await assert.rejects(readEmbeddedManifest(executable));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
