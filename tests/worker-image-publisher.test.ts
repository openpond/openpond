import {
  createRegctlModificationArguments,
  PINNED_PRIME_RL_REVISION,
  verifyPublishedWorkerImage,
} from "../scripts/training/publish-worker-image.js";
import { describe, expect, test } from "vitest";

const sourceLayers = [
  {
    mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
    digest: `sha256:${"a".repeat(64)}`,
    size: 100,
  },
  {
    mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
    digest: `sha256:${"b".repeat(64)}`,
    size: 200,
  },
];
const sourceDiffIds = [
  `sha256:${"c".repeat(64)}`,
  `sha256:${"d".repeat(64)}`,
];

describe("worker image publisher", () => {
  test("creates a streaming immutable layer modification", () => {
    const args = createRegctlModificationArguments({
      sourceManifestRef: `primeintellect/prime-rl@sha256:${"a".repeat(64)}`,
      targetRef: "us-east4-docker.pkg.dev/openpond/releases/worker:v0.0.38-a",
      layerTarPath: "/tmp/worker-layer.tar",
      openpondRelease: "0.0.38",
      publishedAt: "2026-07-24T15:00:00.000Z",
      contextSha256: "e".repeat(64),
    });

    expect(args.slice(0, 3)).toEqual([
      "image",
      "mod",
      `primeintellect/prime-rl@sha256:${"a".repeat(64)}`,
    ]);
    expect(args).toContain("--to-oci");
    expect(args).toContain("tar=/tmp/worker-layer.tar");
    expect(args).toContain(
      "PYTHONPATH=/opt/openpond-training/src",
    );
    expect(args).toContain(
      "ai.openpond.worker.context-sha256=" + "e".repeat(64),
    );
  });

  test("verifies unchanged base layers and exact runtime configuration", () => {
    const contextSha256 = "e".repeat(64);
    const workerLayer = {
      mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
      digest: `sha256:${"f".repeat(64)}`,
      size: 300,
    };
    const result = verifyPublishedWorkerImage({
      sourceManifest: { layers: sourceLayers },
      sourceConfig: { rootfs: { diff_ids: sourceDiffIds } },
      targetManifest: {
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        config: { digest: `sha256:${"1".repeat(64)}`, size: 50 },
        layers: [...sourceLayers, workerLayer],
      },
      targetConfig: {
        architecture: "amd64",
        os: "linux",
        config: {
          User: "appuser",
          WorkingDir: "/app",
          Entrypoint: [
            "python",
            "-m",
            "openpond_training.connected_worker",
          ],
          Cmd: [],
          Env: [
            "PYTHONUNBUFFERED=1",
            "PYTHONPATH=/opt/openpond-training/src",
            "OPENPOND_CONNECTED_WORKER_STATE_DIR=/var/lib/openpond-worker/state",
            "OPENPOND_PRIME_RL_MODEL_CACHE=/var/lib/openpond-worker/model-cache",
            "UV_CACHE_DIR=/var/lib/openpond-worker/uv-cache",
            "HF_HOME=/var/lib/openpond-worker/huggingface",
          ],
          Labels: {
            "org.opencontainers.image.version": "0.0.38",
            "org.opencontainers.image.revision":
              PINNED_PRIME_RL_REVISION,
            "ai.openpond.worker.protocol":
              "openpond.connectedWorker.v1",
            "ai.openpond.worker.engine": "connected-prime-rl",
            "ai.openpond.worker.context-sha256": contextSha256,
          },
        },
        rootfs: {
          diff_ids: [...sourceDiffIds, `sha256:${"2".repeat(64)}`],
        },
      },
      contextSha256,
      openpondRelease: "0.0.38",
    });

    expect(result).toEqual({
      imageSizeBytes: 650,
      workerLayerDigest: workerLayer.digest,
    });
  });

  test("rejects a changed base layer", () => {
    expect(() =>
      verifyPublishedWorkerImage({
        sourceManifest: { layers: sourceLayers },
        sourceConfig: { rootfs: { diff_ids: sourceDiffIds } },
        targetManifest: {
          schemaVersion: 2,
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          layers: [
            { ...sourceLayers[0], digest: `sha256:${"9".repeat(64)}` },
            sourceLayers[1]!,
            {
              digest: `sha256:${"f".repeat(64)}`,
              size: 300,
            },
          ],
        },
        targetConfig: {},
        contextSha256: "e".repeat(64),
        openpondRelease: "0.0.38",
      })
    ).toThrow("changed a base layer");
  });
});
