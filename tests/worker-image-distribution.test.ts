import type { WorkerCatalogEntry } from "@openpond/contracts";
import {
  WorkerImageDistribution,
  assertWorkerCompatibility,
  type WorkerImageCommandRunner,
} from "../packages/trainer-connected/src/index.js";
import { sha256 } from "@openpond/taskset-sdk";
import { describe, expect, test, vi } from "vitest";

describe("worker image distribution", () => {
  test("pulls by digest, reports progress, and verifies the cached digest", async () => {
    const entry = fixtureEntry();
    const runner = queuedRunner([
      { code: 1, stdout: "", stderr: "not found" },
      {
        code: 0,
        stdout: "pulled",
        stderr: "layer 1 Pulling fs layer\nlayer 1 Download complete\n",
      },
      {
        code: 0,
        stdout: `${JSON.stringify([
          `${entry.image.repository}@${entry.image.digest}`,
        ])}\t12000000000\n`,
        stderr: "",
      },
    ]);
    const progress: string[] = [];
    const result = await new WorkerImageDistribution(runner).prepare({
      entry,
      onProgress: (current) => progress.push(current.state),
    });

    expect(result).toMatchObject({
      state: "ready",
      cached: true,
      progress: 1,
    });
    expect(progress).toEqual([
      "downloading",
      "downloading",
      "downloading",
      "verifying",
      "ready",
    ]);
    expect(runner.run).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        command: "docker",
        args: ["pull", `${entry.image.repository}@${entry.image.digest}`],
      }),
    );
  });

  test("cancels without treating an interrupted pull as ready", async () => {
    const entry = fixtureEntry();
    const controller = new AbortController();
    const runner: WorkerImageCommandRunner = {
      run: vi
        .fn()
        .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "not found" })
        .mockImplementationOnce(async () => {
          controller.abort();
          return { code: 130, stdout: "", stderr: "" };
        }),
    };
    const result = await new WorkerImageDistribution(runner).prepare({
      entry,
      signal: controller.signal,
    });
    expect(result.state).toBe("cancelled");
    expect(result.cached).toBe(false);
  });

  test("checks release, protocol, accelerator, and architecture compatibility", () => {
    expect(() =>
      assertWorkerCompatibility({
        entry: fixtureEntry(),
        openpondRelease: "0.0.38",
        workerProtocolVersion: "openpond.connectedWorker.v1",
        accelerator: "cuda",
        architecture: "sm_90",
      }),
    ).not.toThrow();
    expect(() =>
      assertWorkerCompatibility({
        entry: fixtureEntry(),
        openpondRelease: "0.1.0",
        workerProtocolVersion: "openpond.connectedWorker.v1",
        accelerator: "cuda",
      }),
    ).toThrow("OpenPond release");
  });
});

function queuedRunner(
  results: Array<{ code: number; stdout: string; stderr: string }>,
): WorkerImageCommandRunner & { run: ReturnType<typeof vi.fn> } {
  return {
    run: vi.fn(async (input) => {
      const result = results.shift();
      if (!result) throw new Error("Unexpected command.");
      for (const line of result.stderr.split("\n")) {
        if (line) input.onOutput?.(line);
      }
      return result;
    }),
  };
}

function fixtureEntry(): WorkerCatalogEntry {
  return {
    id: "openpond-worker-prime-rl",
    engineAdapterId: "connected-prime-rl",
    workerProtocolVersion: "openpond.connectedWorker.v1",
    openpondReleaseRange: ">=0.0.38 <0.1.0",
    upstreamRevision: "e0d60e4d85ea636873acb2e7083e794740d20226",
    image: {
      repository:
        "us-east4-docker.pkg.dev/openpond/releases/openpond-worker-prime-rl",
      digest: `sha256:${"a".repeat(64)}`,
      sizeBytes: 12_000_000_000,
      sbomRef: "r2://openpond-releases/worker.sbom.cdx.json",
      sbomSha256: sha256("sbom"),
      signatureRef: "kms://projects/openpond/locations/global/key",
    },
    runtime: {
      python: "3.12",
      torch: "2.9",
      accelerator: "cuda",
      acceleratorVersion: "12.8.1",
      architectures: ["sm_90"],
    },
    methods: ["sft", "dpo", "ppo", "grpo"],
    modelFamilies: ["transformers"],
    precisions: ["fp16", "bf16", "tf32"],
    conformanceReceipt: {
      ref: "oci://registry.example.test/worker@sha256:" + "b".repeat(64),
      sha256: sha256("conformance"),
    },
  };
}
