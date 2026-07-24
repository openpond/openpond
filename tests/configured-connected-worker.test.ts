import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { createConfiguredConnectedWorker } from "../apps/server/src/training/configured-connected-worker.js";

describe("configured connected worker", () => {
  test("stays disabled when absent and fails closed on partial configuration", () => {
    expect(
      createConfiguredConnectedWorker({
        storeDir: "/tmp/openpond-fixture",
        environment: {},
      }),
    ).toBeNull();
    expect(() =>
      createConfiguredConnectedWorker({
        storeDir: "/tmp/openpond-fixture",
        environment: {
          OPENPOND_CONNECTED_WORKER_URL:
            "https://worker.example.test",
        },
      }),
    ).toThrow(/requires URL.*lease file.*identity key file.*image digest/i);
  });

  test("builds the exact connected-prime-rl adapter from file-backed secrets", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "openpond-connected-config-"),
    );
    try {
      const leaseFile = path.join(root, "lease");
      const identityFile = path.join(root, "identity");
      const clientCertificateFile = path.join(root, "client.crt");
      const clientPrivateKeyFile = path.join(root, "client.key");
      const serverCaFile = path.join(root, "server-ca.crt");
      await writeFile(leaseFile, "lease-ref\n", { mode: 0o600 });
      await writeFile(identityFile, "identity-key\n", {
        mode: 0o600,
      });
      await writeFile(
        clientCertificateFile,
        "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n",
        { mode: 0o644 },
      );
      await writeFile(
        clientPrivateKeyFile,
        "-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----\n",
        { mode: 0o600 },
      );
      await writeFile(
        serverCaFile,
        "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n",
        { mode: 0o644 },
      );
      const adapter = createConfiguredConnectedWorker({
        storeDir: root,
        environment: {
          OPENPOND_CONNECTED_WORKER_URL:
            "https://worker.example.test",
          OPENPOND_CONNECTED_WORKER_AUTHENTICATION_LEASE_FILE:
            leaseFile,
          OPENPOND_CONNECTED_WORKER_IDENTITY_KEY_FILE: identityFile,
          OPENPOND_CONNECTED_WORKER_IMAGE_DIGEST: `sha256:${"a".repeat(64)}`,
          OPENPOND_CONNECTED_WORKER_CLIENT_CERTIFICATE_FILE:
            clientCertificateFile,
          OPENPOND_CONNECTED_WORKER_CLIENT_PRIVATE_KEY_FILE:
            clientPrivateKeyFile,
          OPENPOND_CONNECTED_WORKER_SERVER_CA_FILE: serverCaFile,
        },
      });
      expect(adapter?.id).toBe("connected-prime-rl");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
