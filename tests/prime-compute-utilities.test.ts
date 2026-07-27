import {
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  afterEach,
  describe,
  expect,
  test,
} from "vitest";

import {
  choosePrimeComputeQuote,
} from "../apps/server/src/training/prime-compute-quote.ts";
import {
  materializeRemotePythonProject,
} from "../apps/server/src/training/python-project-staging.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Prime compute quote selection", () => {
  test("chooses the least costly affordable runtime", () => {
    const selected = choosePrimeComputeQuote({
      devices: [
        { id: "expensive", name: "Expensive GPU" },
        { id: "cheap", name: "Cheap GPU" },
      ],
      hourlyQuotes: new Map([
        ["expensive", { quoteId: "quote-expensive", hourlyCostUsd: 4 }],
        ["cheap", { quoteId: "quote-cheap", hourlyCostUsd: 2 }],
      ]),
      walletBalanceUsd: 3,
      now: new Date("2026-07-27T12:00:00.000Z"),
      minimumDurationMs: 20 * 60_000,
      targetDurationMs: 45 * 60_000,
    });

    expect(selected).toMatchObject({
      device: { id: "cheap" },
      quoteId: "quote-cheap",
      durationMs: 45 * 60_000,
      estimatedCostUsd: 1.5,
    });
  });

  test("rejects a wallet that cannot cover the minimum runtime", () => {
    expect(() =>
      choosePrimeComputeQuote({
        devices: [{ id: "gpu", name: "GPU" }],
        hourlyQuotes: new Map([
          ["gpu", { quoteId: "quote", hourlyCostUsd: 6 }],
        ]),
        walletBalanceUsd: 1,
        now: new Date("2026-07-27T12:00:00.000Z"),
        minimumDurationMs: 20 * 60_000,
      }),
    ).toThrow("minimum requested runtime");
  });
});

describe("Python project staging", () => {
  test("copies only the locked project definition and runtime source", async () => {
    const root = await import("node:fs/promises").then(({ mkdtemp }) =>
      mkdtemp(path.join(os.tmpdir(), "openpond-python-staging-")),
    );
    temporaryDirectories.push(root);
    const sourceDirectory = path.join(root, "source");
    const artifactRoot = path.join(root, "artifacts");
    await mkdir(path.join(sourceDirectory, "src", "openpond_training"), {
      recursive: true,
    });
    await Promise.all([
      writeFile(path.join(sourceDirectory, "pyproject.toml"), "[project]\n"),
      writeFile(path.join(sourceDirectory, "uv.lock"), "version = 1\n"),
      writeFile(
        path.join(sourceDirectory, "src", "openpond_training", "__init__.py"),
        "",
      ),
      writeFile(path.join(sourceDirectory, "ignored.txt"), "ignored"),
    ]);

    const staged = await materializeRemotePythonProject({
      sourceDirectory,
      artifactRoot,
    });

    await expect(
      readFile(path.join(staged, "pyproject.toml"), "utf8"),
    ).resolves.toBe("[project]\n");
    await expect(
      readFile(path.join(staged, "uv.lock"), "utf8"),
    ).resolves.toBe("version = 1\n");
    await expect(
      readFile(
        path.join(staged, "src", "openpond_training", "__init__.py"),
        "utf8",
      ),
    ).resolves.toBe("");
    await expect(
      readFile(path.join(staged, "ignored.txt"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
