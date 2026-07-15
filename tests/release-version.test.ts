import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";

import {
  assertReleaseVersion,
  releaseVersionedPackageFiles,
  writeReleaseVersion,
} from "../scripts/release-version";

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function createReleaseFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "openpond-release-version-"));
  await writeJson(path.join(root, "package.json"), {
    name: "root",
    version: "0.0.23",
    openpondReleaseVersioned: true,
    workspaces: ["apps/*", "packages/*"],
  });
  await writeJson(path.join(root, "apps", "desktop", "package.json"), {
    name: "desktop",
    version: "0.0.23",
    openpondReleaseVersioned: true,
  });
  await writeJson(path.join(root, "apps", "server", "package.json"), {
    name: "server",
    version: "0.0.23",
    openpondReleaseVersioned: true,
  });
  await writeJson(path.join(root, "packages", "logging", "package.json"), {
    name: "logging",
    version: "0.0.23",
    openpondReleaseVersioned: true,
  });
  await writeJson(path.join(root, "packages", "independent", "package.json"), {
    name: "independent",
    version: "4.2.0",
  });
  await mkdir(path.join(root, "apps", "server", "src"), { recursive: true });
  await writeFile(
    path.join(root, "apps", "server", "src", "constants.ts"),
    'export const VERSION = "0.0.23";\n',
  );
  await writeFile(
    path.join(root, "bun.lock"),
    `${JSON.stringify(
      {
        lockfileVersion: 1,
        workspaces: {
          "": { name: "root" },
          "apps/desktop": { name: "desktop", version: "0.0.23" },
          "apps/server": { name: "server", version: "0.0.23" },
          "packages/independent": { name: "independent", version: "4.2.0" },
          "packages/logging": { name: "logging", version: "0.0.23" },
        },
      },
      null,
      2,
    )}\n`,
  );
  return root;
}

describe("release source versions", () => {
  test("discovers marked workspaces and leaves independently versioned packages alone", async () => {
    const root = await createReleaseFixture();
    try {
      expect(await releaseVersionedPackageFiles(root)).toEqual([
        "apps/desktop/package.json",
        "apps/server/package.json",
        "package.json",
        "packages/logging/package.json",
      ]);

      await expect(assertReleaseVersion(root, "0.0.23")).resolves.toBeUndefined();
      await writeReleaseVersion(root, "0.0.24");
      await expect(assertReleaseVersion(root, "0.0.24")).resolves.toBeUndefined();

      const independent = JSON.parse(
        await readFile(path.join(root, "packages", "independent", "package.json"), "utf8"),
      ) as { version: string };
      expect(independent.version).toBe("4.2.0");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports every source that would create a mixed-version release", async () => {
    const root = await createReleaseFixture();
    try {
      await writeJson(path.join(root, "packages", "logging", "package.json"), {
        name: "logging",
        version: "0.0.22",
        openpondReleaseVersioned: true,
      });
      await writeFile(
        path.join(root, "apps", "server", "src", "constants.ts"),
        'export const VERSION = "0.0.21";\n',
      );

      await expect(assertReleaseVersion(root, "0.0.23")).rejects.toThrow(
        /packages\/logging\/package\.json: expected 0\.0\.23, found 0\.0\.22[\s\S]*apps\/server\/src\/constants\.ts: expected 0\.0\.23, found 0\.0\.21/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps the checked-in release cohort aligned", async () => {
    const root = path.resolve(import.meta.dir, "..");
    const rootPackage = JSON.parse(
      await readFile(path.join(root, "package.json"), "utf8"),
    ) as { version?: string };

    expect(rootPackage.version).toMatch(/^\d+\.\d+\.\d+$/);
    await expect(assertReleaseVersion(root, rootPackage.version!)).resolves.toBeUndefined();
  });
});
