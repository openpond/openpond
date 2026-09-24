import { expect, test } from "vitest";
import { packageContentErrors } from "../scripts/distribution/package-policy.ts";
import { assetChanges, compareSizes } from "../scripts/distribution/size-comparison.ts";
import type { SizeSnapshot } from "../scripts/distribution/size-snapshot.ts";

const KiB = 1024;
function snapshot(packed = 8 * 1024 * KiB): SizeSnapshot {
  return {
    schemaVersion: 1, revision: "a".repeat(40), nodeVersion: "v24.18.0", npmVersion: "11.0.0",
    metrics: { packed, unpacked: 27 * 1024 * KiB, rendererJs: 17 * 1024 * KiB, initialAssets: 500 * KiB },
    files: [],
  };
}

// Failure story: a tiny feature should not block CI, while a large dependency
// addition must produce a visible warning without masquerading as a hard limit.
test("distinguishes ordinary growth, substantial growth, and shrinkage", () => {
  const base = snapshot();
  expect(compareSizes(snapshot(base.metrics.packed + 10 * KiB), base).warnings).toEqual([]);
  expect(compareSizes(snapshot(base.metrics.packed + 600 * KiB), base).warnings).toHaveLength(1);
  expect(compareSizes(snapshot(base.metrics.packed - 600 * KiB), base).warnings).toEqual([]);
  expect(compareSizes(snapshot()).warnings).toEqual([]);
  const differentToolchain = { ...base, npmVersion: "12.0.0" };
  expect(() => compareSizes(base, differentToolchain)).toThrow(/same Node and npm/);
});

// Failure story: changing a content hash or splitting a runtime chunk otherwise
// looks like megabytes of new code and hides the actual feature's small delta.
test("compares renamed assets and redistributed chunks without counting them twice", () => {
  const base = snapshot();
  base.files = [
    { path: "dist/web/assets/App-AbCd1234.js", size: 1000, gzip: 300 },
    { path: "dist/chunks/chunk-ABCD1234.js", size: 2000, gzip: 600 },
    { path: "dist/web/assets/Removed-abcdefgh.js", size: 100, gzip: 50 },
  ];
  const head = snapshot();
  head.files = [
    { path: "dist/web/assets/App-XyZ_5678.js", size: 1050, gzip: 310 },
    { path: "dist/chunks/chunk-EFGH5678.js", size: 1200, gzip: 360 },
    { path: "dist/chunks/feature-IJKL9012.js", size: 800, gzip: 240 },
  ];
  expect(assetChanges(head, base).map(({ delta }) => delta)).toEqual([50, 0, -100]);
});

// Failure story: npm's broad dist glob can silently publish test data, source
// maps, or stale hashed chunks even when the package is well below its byte cap.
test("rejects unintended payloads and missing/stale runtime chunks, preserving declarations", () => {
  const runtime = ["dist/cli.js", "dist/chunks/chunk-CURRENT1.js"];
  const good = [...runtime, "package.json", "dist/app-server.d.ts", "dist/web/assets/App-abcdefgh.js", "dist/skills/example/SKILL.md"]
    .map((path) => ({ path, size: 1 }));
  expect(packageContentErrors(good, runtime)).toEqual([]);
  for (const path of ["dist/fixtures/example.pdf", "dist/web/assets/App.js.map", "dist/example.test.js", "dist/source.ts", "src/main.js", "dist/chunks/chunk-OLD12345.js"]) {
    expect(packageContentErrors([...good, { path, size: 1 }], runtime).length).toBeGreaterThan(0);
  }
  expect(packageContentErrors(good.filter((file) => file.path !== runtime[1]), runtime)).toHaveLength(1);
});
