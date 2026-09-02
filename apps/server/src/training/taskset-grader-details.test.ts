import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Taskset } from "@openpond/contracts";
import { afterEach, describe, expect, it } from "vitest";

import type { SqliteStore } from "../store/store.js";
import { readTasksetGraderDetails } from "./taskset-grader-details.js";

const temporaryDirectories: string[] = [];
const HASH = "a".repeat(64);

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe("Taskset grader details", () => {
  it("returns the user-owned runtime grader source with verified integrity", async () => {
    const storeDir = await temporaryDirectory();
    const taskset = fixtureTaskset("source-taskset");
    const graderDirectory = path.join(storeDir, "training", "tasksets", "source-taskset", "graders");
    await mkdir(graderDirectory, { recursive: true });
    const source = "def grade(trajectory):\n    return 1.0\n";
    const moduleSha256 = createHash("sha256").update(source).digest("hex");
    await writeFile(path.join(graderDirectory, "grader.py"), source, "utf8");
    await writeFile(path.join(graderDirectory, "managed-rl-runtime.json"), JSON.stringify({
      protocolVersion: "openpond.managedRlJsonlRuntime.v1",
      module: "graders/grader.py",
      moduleSha256,
      command: ["python", "{module}"],
      cwd: "/tmp/taskset-runtime",
      maxTurns: 12,
    }), "utf8");

    const details = await readTasksetGraderDetails({
      store: storeFor(taskset),
      storeDir,
      tasksetId: taskset.id,
    });

    expect(details.sourceTasksetId).toBe("source-taskset");
    expect(details.runtime?.module).toBe("graders/grader.py");
    expect(details.sources).toEqual([expect.objectContaining({
      graderId: "taskset-reward",
      path: "graders/grader.py",
      language: "python",
      content: source,
      sha256: moduleSha256,
      declaredSha256: moduleSha256,
      integrity: "verified",
    })]);
    expect(details.unavailableReason).toBeNull();
  });

  it("does not read a Taskset package outside the user Taskset directory", async () => {
    const storeDir = await temporaryDirectory();
    const externalRoot = path.join(storeDir, "external-taskset");
    await mkdir(path.join(storeDir, "training", "tasksets"), { recursive: true });
    await mkdir(path.join(externalRoot, "graders"), { recursive: true });
    const taskset = fixtureTaskset("../../external-taskset");

    const details = await readTasksetGraderDetails({
      store: storeFor(taskset),
      storeDir,
      tasksetId: taskset.id,
    });

    expect(details.sources).toEqual([]);
    expect(details.runtime).toBeNull();
    expect(details.unavailableReason).toContain("outside the user Taskset directory");
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "openpond-taskset-grader-details-"));
  temporaryDirectories.push(directory);
  return directory;
}

function fixtureTaskset(sourceTasksetId: string): Taskset {
  return {
    id: "published-taskset",
    revision: 3,
    contentHash: HASH,
    metadata: { importedFromTaskset: { id: sourceTasksetId } },
    environment: { metadata: {} },
    graders: [{
      id: "taskset-reward",
      version: "1",
      label: "Taskset reward",
      kind: "content",
      weight: 1,
      hardGate: false,
      rewardEligible: true,
      privileged: true,
      config: {},
      metadata: {},
    }],
  } as unknown as Taskset;
}

function storeFor(taskset: Taskset): SqliteStore {
  return { getTaskset: async () => taskset } as unknown as SqliteStore;
}
