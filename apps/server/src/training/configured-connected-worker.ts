import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import type { Stats } from "node:fs";
import path from "node:path";

import {
  AuthenticatedConnectedWorker,
  ConnectedTrainingEngineAdapter,
  HttpConnectedWorkerTransport,
  createMtlsWorkerFetch,
} from "@openpond/trainer-connected";

import { resolveLocalConnectedWorkerBundle } from "./portable-connected-worker.js";

export type ConnectedWorkerEnvironment = {
  OPENPOND_CONNECTED_WORKER_URL?: string;
  OPENPOND_CONNECTED_WORKER_AUTHENTICATION_LEASE_FILE?: string;
  OPENPOND_CONNECTED_WORKER_IDENTITY_KEY_FILE?: string;
  OPENPOND_CONNECTED_WORKER_IMAGE_DIGEST?: string;
  OPENPOND_CONNECTED_WORKER_CLIENT_CERTIFICATE_FILE?: string;
  OPENPOND_CONNECTED_WORKER_CLIENT_PRIVATE_KEY_FILE?: string;
  OPENPOND_CONNECTED_WORKER_SERVER_CA_FILE?: string;
};

export function createConfiguredConnectedWorker(input: {
  storeDir: string;
  environment: ConnectedWorkerEnvironment;
}): ConnectedTrainingEngineAdapter | null {
  const endpoint = input.environment.OPENPOND_CONNECTED_WORKER_URL?.trim();
  const leaseFile =
    input.environment
      .OPENPOND_CONNECTED_WORKER_AUTHENTICATION_LEASE_FILE?.trim();
  const identityFile =
    input.environment.OPENPOND_CONNECTED_WORKER_IDENTITY_KEY_FILE?.trim();
  const imageDigest =
    input.environment.OPENPOND_CONNECTED_WORKER_IMAGE_DIGEST?.trim();
  const clientCertificateFile =
    input.environment
      .OPENPOND_CONNECTED_WORKER_CLIENT_CERTIFICATE_FILE?.trim();
  const clientPrivateKeyFile =
    input.environment
      .OPENPOND_CONNECTED_WORKER_CLIENT_PRIVATE_KEY_FILE?.trim();
  const serverCaFile =
    input.environment.OPENPOND_CONNECTED_WORKER_SERVER_CA_FILE?.trim();
  const supplied = [
    endpoint,
    leaseFile,
    identityFile,
    imageDigest,
    clientCertificateFile,
    clientPrivateKeyFile,
    serverCaFile,
  ].filter(Boolean);
  if (supplied.length === 0) return null;
  if (
    !endpoint ||
    !leaseFile ||
    !identityFile ||
    !imageDigest ||
    !clientCertificateFile ||
    !clientPrivateKeyFile ||
    !serverCaFile
  ) {
    throw new Error(
      "Connected worker configuration requires URL, authentication lease file, identity key file, image digest, client certificate, client private key, and server CA files.",
    );
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(imageDigest)) {
    throw new Error(
      "Connected worker configuration requires an immutable image digest.",
    );
  }
  const authenticationLease = readRequiredSecretFile(
    leaseFile,
    "authentication lease",
  );
  const identityKey = readRequiredSecretFile(
    identityFile,
    "identity key",
  );
  const clientCertificate = readRequiredFile(
    clientCertificateFile,
    "client certificate",
  );
  const clientPrivateKey = readRequiredSecretFile(
    clientPrivateKeyFile,
    "client private key",
    false,
  );
  const serverCertificateAuthority = readRequiredFile(
    serverCaFile,
    "server CA",
  );
  const transport = new HttpConnectedWorkerTransport(
    new URL(endpoint),
    createMtlsWorkerFetch({
      clientCertificate,
      clientPrivateKey,
      serverCertificateAuthority,
    }),
  );
  return new ConnectedTrainingEngineAdapter(
    new AuthenticatedConnectedWorker(
      transport,
      {
        verifyNonce: async ({ nonce, signature }) => {
          const expected = createHmac("sha256", identityKey)
            .update(nonce)
            .digest();
          let actual: Buffer;
          try {
            actual = Buffer.from(signature, "hex");
          } catch {
            return false;
          }
          return (
            actual.byteLength === expected.byteLength &&
            timingSafeEqual(actual, expected)
          );
        },
      },
      {
        clientRelease: "0.0.38",
        expectedWorkerImageDigest: imageDigest,
        secretLeaseRef: authenticationLease,
        nonce: () => randomBytes(32).toString("hex"),
      },
    ),
    {
      id: "connected-prime-rl",
      artifactDirectory: path.join(
        input.storeDir,
        "training",
        "connected-artifacts",
      ),
      resolvedBundle: (plan) =>
        resolveLocalConnectedWorkerBundle({
          storeDir: input.storeDir,
          plan,
        }),
    },
  );
}

function readRequiredSecretFile(
  file: string,
  label: string,
  trim = true,
): string {
  const metadata = requireRegularFile(file, label);
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(
      `Connected worker ${label} file must not be readable or writable by group or other users.`,
    );
  }
  const value = readFileSync(file, {
    encoding: "utf8",
    flag: "r",
  });
  if (!value.trim()) {
    throw new Error(`Connected worker ${label} file is empty.`);
  }
  return trim ? value.trim() : value;
}

function readRequiredFile(file: string, label: string): string {
  requireRegularFile(file, label);
  const value = readFileSync(file, {
    encoding: "utf8",
    flag: "r",
  });
  if (!value.trim()) {
    throw new Error(`Connected worker ${label} file is empty.`);
  }
  return value;
}

function requireRegularFile(
  file: string,
  label: string,
): Stats {
  const metadata = lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(
      `Connected worker ${label} must be a regular non-symlink file.`,
    );
  }
  return metadata;
}
