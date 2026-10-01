import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPackage } from "@electron/asar";
import { expect, test } from "vitest";
import { checkDesktopPackage } from "../scripts/check-desktop-package";
import { collectPerformanceReport } from "../scripts/report-performance";

const MiB = 1024 * 1024;

// Failure story: normal desktop growth previously blocked releases before smoke
// tests. A package above every former size cap must pass, but corruption must fail.
test("accepts desktop growth while rejecting a corrupt packaged runtime", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openpond-package-growth-"));
  try {
    const resources = path.join(root, "release/linux-arm64-unpacked/resources");
    const app = path.join(root, "app");
    const stage = path.join(root, "apps/desktop/stage/runtime");
    await Promise.all([mkdir(resources, { recursive: true }), mkdir(path.join(app, "dist"), { recursive: true }), mkdir(stage, { recursive: true })]);
    await Promise.all([
      writeFile(path.join(app, "dist/main.js"), Buffer.alloc(3 * MiB, 32)),
      writeFile(path.join(app, "dist/preload.js"), "console.log('preload');"),
      writeFile(path.join(app, "package.json"), "{}"),
      sparseFile(path.join(root, "release/openpond-test-linux-arm64.AppImage"), 200 * MiB),
      sparseFile(path.join(root, "release/linux-arm64-unpacked/electron"), 450 * MiB),
    ]);
    await createPackage(app, path.join(resources, "app.asar"));
    const runtime = Buffer.alloc(34 * MiB, 32);
    await writeFile(path.join(resources, "server.js"), runtime);
    const inventory = JSON.stringify({
      schemaVersion: 1, platform: "linux", arch: "arm64", generatedAt: new Date().toISOString(),
      totalBytes: runtime.byteLength, fileCount: 1,
      files: [{ path: "server.js", bytes: runtime.byteLength, sha256: createHash("sha256").update(runtime).digest("hex"), verification: "sha256" }],
    });
    await Promise.all([writeFile(path.join(resources, "runtime-inventory.json"), inventory), writeFile(path.join(stage, "runtime-inventory.json"), inventory)]);
    await expect(checkDesktopPackage({ root, platform: "linux", arch: "arm64" })).resolves.toMatchObject({
      artifact: { bytes: 200 * MiB }, stagedRuntime: { bytes: 34 * MiB },
    });
    await writeFile(path.join(resources, "server.js"), "corrupt");
    await expect(checkDesktopPackage({ root, platform: "linux", arch: "arm64" })).rejects.toThrow(/inventory verification/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Failure story: renderer growth must stay advisory, while a missing entry asset
// must remain a build failure rather than being swallowed as a size warning.
test("reports oversized renderer assets and rejects missing entry assets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openpond-renderer-growth-"));
  try {
    const dist = path.join(root, "apps/web/dist");
    await mkdir(path.join(dist, "assets"), { recursive: true });
    await writeFile(path.join(dist, "index.html"), '<script type="module" src="/assets/entry.js"></script>');
    await sparseFile(path.join(dist, "assets/entry.js"), 40 * MiB);
    const result = await collectPerformanceReport({ root, rendererOnly: true });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(3);
    const failedStartup = await collectPerformanceReport({ root });
    expect(failedStartup.errors.length).toBeGreaterThan(0);
    await rm(path.join(dist, "assets/entry.js"));
    await expect(collectPerformanceReport({ root, rendererOnly: true })).rejects.toThrow(/missing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function sparseFile(file: string, bytes: number) {
  await writeFile(file, "");
  await truncate(file, bytes);
}
