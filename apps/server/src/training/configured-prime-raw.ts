import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import type { Stats } from "node:fs";
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  TrainingEngineCapabilitiesSchema,
  type TrainingEngineCapabilities,
} from "@openpond/contracts";
import {
  PrimeComputeTargetAdapter,
  PrimeRawComputeHttpClient,
} from "@openpond/compute-provider-prime";
import { contentHash } from "@openpond/taskset-sdk";
import {
  AuthenticatedConnectedWorker,
  ConnectedTrainingEngineAdapter,
  FileProvisionedConnectedWorkerSessionStore,
  HttpConnectedWorkerTransport,
  ProvisionedConnectedTrainingEngineAdapter,
  SpawnSshCommandRunner,
  SshConnectedWorkerBootstrapper,
  createMtlsWorkerFetch,
  scanSshHostFingerprint,
  type ConnectedWorkerBootstrapReceipt,
  type ProvisionedConnectedWorkerFactory,
} from "@openpond/trainer-connected";
import type { ComputeLease } from "@openpond/training-sdk";

import { resolveLocalConnectedWorkerBundle } from "./portable-connected-worker.js";
import type { PortableTrainingAdapterComposition } from "./portable-training-server-dependencies.js";

const PRIME_RL_REVISION =
  "e0d60e4d85ea636873acb2e7083e794740d20226";

export type PrimeRawEnvironment = {
  OPENPOND_PRIME_API_KEY_FILE?: string;
  OPENPOND_PRIME_SSH_KEY_ID?: string;
  OPENPOND_PRIME_SSH_PRIVATE_KEY_FILE?: string;
  OPENPOND_PRIME_WORKER_TEMPLATE_ID?: string;
  OPENPOND_PRIME_WORKER_IMAGE_REPOSITORY?: string;
  OPENPOND_PRIME_WORKER_IMAGE_DIGEST?: string;
  OPENPOND_PRIME_WORKER_CAPABILITY_RECEIPT?: string;
  OPENPOND_PRIME_WORKER_REGISTRY_AUTH_FILE?: string;
  OPENPOND_PRIME_WORKER_AUTHENTICATION_LEASE_FILE?: string;
  OPENPOND_PRIME_WORKER_IDENTITY_KEY_FILE?: string;
  OPENPOND_PRIME_WORKER_TLS_CERTIFICATE_FILE?: string;
  OPENPOND_PRIME_WORKER_TLS_PRIVATE_KEY_FILE?: string;
  OPENPOND_PRIME_WORKER_CLIENT_CA_FILE?: string;
  OPENPOND_PRIME_CLIENT_CERTIFICATE_FILE?: string;
  OPENPOND_PRIME_CLIENT_PRIVATE_KEY_FILE?: string;
  OPENPOND_PRIME_SERVER_CA_FILE?: string;
  OPENPOND_PRIME_TLS_SERVER_NAME?: string;
  OPENPOND_PRIME_WORKER_PORT?: string;
  OPENPOND_PRIME_WORKER_RUNTIME?: string;
  OPENPOND_PRIME_API_URL?: string;
};

export function createConfiguredPrimeRaw(input: {
  storeDir: string;
  environment: PrimeRawEnvironment;
  request?: typeof fetch;
}): PortableTrainingAdapterComposition | null {
  const environment = input.environment;
  const values = {
    apiKeyFile: environment.OPENPOND_PRIME_API_KEY_FILE?.trim(),
    sshKeyId: environment.OPENPOND_PRIME_SSH_KEY_ID?.trim(),
    sshPrivateKeyFile:
      environment.OPENPOND_PRIME_SSH_PRIVATE_KEY_FILE?.trim(),
    workerTemplateId:
      environment.OPENPOND_PRIME_WORKER_TEMPLATE_ID?.trim(),
    imageRepository:
      environment.OPENPOND_PRIME_WORKER_IMAGE_REPOSITORY?.trim(),
    imageDigest:
      environment.OPENPOND_PRIME_WORKER_IMAGE_DIGEST?.trim(),
    capabilityReceipt:
      environment.OPENPOND_PRIME_WORKER_CAPABILITY_RECEIPT?.trim(),
    registryAuthFile:
      environment.OPENPOND_PRIME_WORKER_REGISTRY_AUTH_FILE?.trim(),
    authenticationLeaseFile:
      environment
        .OPENPOND_PRIME_WORKER_AUTHENTICATION_LEASE_FILE?.trim(),
    identityKeyFile:
      environment.OPENPOND_PRIME_WORKER_IDENTITY_KEY_FILE?.trim(),
    workerTlsCertificateFile:
      environment.OPENPOND_PRIME_WORKER_TLS_CERTIFICATE_FILE?.trim(),
    workerTlsPrivateKeyFile:
      environment.OPENPOND_PRIME_WORKER_TLS_PRIVATE_KEY_FILE?.trim(),
    workerClientCaFile:
      environment.OPENPOND_PRIME_WORKER_CLIENT_CA_FILE?.trim(),
    clientCertificateFile:
      environment.OPENPOND_PRIME_CLIENT_CERTIFICATE_FILE?.trim(),
    clientPrivateKeyFile:
      environment.OPENPOND_PRIME_CLIENT_PRIVATE_KEY_FILE?.trim(),
    serverCaFile:
      environment.OPENPOND_PRIME_SERVER_CA_FILE?.trim(),
    tlsServerName:
      environment.OPENPOND_PRIME_TLS_SERVER_NAME?.trim(),
  };
  const supplied = Object.values(values).filter(Boolean);
  if (supplied.length === 0) return null;
  if (Object.values(values).some((value) => !value)) {
    throw new Error(
      "Prime raw compute configuration requires provider, SSH, worker image, authentication, identity, and complete mTLS settings.",
    );
  }
  const required = values as {
    [K in keyof typeof values]: string;
  };
  if (!/^sha256:[a-f0-9]{64}$/.test(required.imageDigest)) {
    throw new Error(
      "Prime raw compute requires an immutable worker image digest.",
    );
  }
  if (!/^[a-f0-9]{64}$/.test(required.capabilityReceipt)) {
    throw new Error(
      "Prime raw compute requires the worker conformance capability receipt.",
    );
  }
  const workerPort = integerSetting(
    environment.OPENPOND_PRIME_WORKER_PORT,
    8443,
    1,
    65_535,
    "worker port",
  );
  const runtime =
    environment.OPENPOND_PRIME_WORKER_RUNTIME?.trim() || "docker";
  if (runtime !== "docker" && runtime !== "podman") {
    throw new Error(
      "Prime raw compute worker runtime must be docker or podman.",
    );
  }
  requirePrivateFile(required.apiKeyFile, "Prime API key");
  requirePrivateFile(
    required.sshPrivateKeyFile,
    "Prime SSH private key",
  );
  requirePrivateFile(
    required.authenticationLeaseFile,
    "Prime worker authentication lease",
  );
  requirePrivateFile(
    required.registryAuthFile,
    "Prime worker registry authentication",
  );
  requirePrivateFile(
    required.identityKeyFile,
    "Prime worker identity key",
  );
  requirePrivateFile(
    required.workerTlsPrivateKeyFile,
    "Prime worker TLS private key",
  );
  requirePrivateFile(
    required.clientPrivateKeyFile,
    "Prime client private key",
  );
  for (const [file, label] of [
    [required.workerTlsCertificateFile, "Prime worker TLS certificate"],
    [required.workerClientCaFile, "Prime worker client CA"],
    [required.clientCertificateFile, "Prime client certificate"],
    [required.serverCaFile, "Prime server CA"],
  ] as const) {
    requireRegularFile(file, label);
  }

  const compute = new PrimeComputeTargetAdapter(
    new PrimeRawComputeHttpClient({
      apiKey: () => readSecret(required.apiKeyFile, "Prime API key"),
      sshKeyId: required.sshKeyId,
      workerTemplateId: required.workerTemplateId,
      baseUrl: environment.OPENPOND_PRIME_API_URL?.trim(),
      request: input.request,
      verifySshHostKey: scanSshHostFingerprint,
    }),
  );
  const workers = new ConfiguredPrimeWorkerFactory({
    storeDir: input.storeDir,
    imageRepository: required.imageRepository,
    imageDigest: required.imageDigest,
    capabilityReceipt: required.capabilityReceipt,
    registryAuthFile: required.registryAuthFile,
    authenticationLeaseFile: required.authenticationLeaseFile,
    identityKeyFile: required.identityKeyFile,
    workerTlsCertificateFile:
      required.workerTlsCertificateFile,
    workerTlsPrivateKeyFile:
      required.workerTlsPrivateKeyFile,
    workerClientCaFile: required.workerClientCaFile,
    clientCertificateFile: required.clientCertificateFile,
    clientPrivateKeyFile: required.clientPrivateKeyFile,
    serverCaFile: required.serverCaFile,
    tlsServerName: required.tlsServerName,
    sshPrivateKeyFile: required.sshPrivateKeyFile,
    workerPort,
    runtime,
  });
  const capabilities = () =>
    primeWorkerCapabilities(required.capabilityReceipt);
  const engine = new ProvisionedConnectedTrainingEngineAdapter(
    compute,
    workers,
    new FileProvisionedConnectedWorkerSessionStore(
      path.join(
        input.storeDir,
        "training",
        "provisioned-connected-sessions",
      ),
    ),
    capabilities,
    { id: "connected-prime-rl" },
  );
  return {
    compute: [compute],
    workerImageDigest: required.imageDigest,
    primeRawConfigured: true,
    engineRoutes: [
      {
        canonicalEngineId: "connected-prime-rl",
        route: {
          id: "prime-raw-ssh",
          matches: (plan) =>
            plan.compute.adapterId === "prime-raw" &&
            plan.runtime.adapterId === "local-harness",
          adapter: engine,
        },
      },
    ],
  };
}

type BootstrapRecord = {
  schemaVersion: "openpond.primeWorkerBootstrap.v1";
  runId: string;
  computeLeaseId: string;
  workerImageDigest: string;
  receipt: ConnectedWorkerBootstrapReceipt;
};

class ConfiguredPrimeWorkerFactory
  implements ProvisionedConnectedWorkerFactory
{
  private readonly bootstrapper: SshConnectedWorkerBootstrapper;
  private readonly root: string;

  constructor(
    private readonly options: {
      storeDir: string;
      imageRepository: string;
      imageDigest: string;
      capabilityReceipt: string;
      registryAuthFile: string;
      authenticationLeaseFile: string;
      identityKeyFile: string;
      workerTlsCertificateFile: string;
      workerTlsPrivateKeyFile: string;
      workerClientCaFile: string;
      clientCertificateFile: string;
      clientPrivateKeyFile: string;
      serverCaFile: string;
      tlsServerName: string;
      sshPrivateKeyFile: string;
      workerPort: number;
      runtime: "docker" | "podman";
    },
  ) {
    this.root = path.join(
      options.storeDir,
      "training",
      "prime-worker-bootstraps",
    );
    this.bootstrapper = new SshConnectedWorkerBootstrapper(
      new SpawnSshCommandRunner(undefined, {
        identityFile: options.sshPrivateKeyFile,
      }),
    );
  }

  async connect(input: {
    runId: string;
    lease: ComputeLease;
    workerImageDigest: string;
  }): Promise<ConnectedTrainingEngineAdapter> {
    const connection = sshConnection(input.lease);
    if (
      input.workerImageDigest !== this.options.imageDigest ||
      input.lease.adapterId !== "prime-raw"
    ) {
      throw new Error(
        "Prime worker factory received a changed compute or image binding.",
      );
    }
    let record = await this.load(input.runId);
    if (record) {
      assertBootstrapRecord(record, input);
      const connected = this.adapter(input, record);
      try {
        await connected.capabilities();
        return connected;
      } catch {
        await this.bootstrapper
          .destroy({
            ...connection,
            receipt: record.receipt,
          })
          .catch(() => undefined);
        await this.remove(input.runId);
        record = null;
      }
    }
    const receipt = await this.bootstrapper.bootstrapWithSecrets({
      ...connection,
      runtime: this.options.runtime,
      imageRepository: this.options.imageRepository,
      imageDigest: input.workerImageDigest,
      workerPort: this.options.workerPort,
      authenticationLease: readSecret(
        this.options.authenticationLeaseFile,
        "Prime worker authentication lease",
      ),
      workerId: `prime-${contentHash(input.runId).slice(0, 24)}`,
      workerRelease: "0.0.38",
      capabilityReceipt: this.options.capabilityReceipt,
      identityKey: readSecret(
        this.options.identityKeyFile,
        "Prime worker identity key",
      ),
      tlsCertificate: readText(
        this.options.workerTlsCertificateFile,
        "Prime worker TLS certificate",
      ),
      tlsPrivateKey: readSecret(
        this.options.workerTlsPrivateKeyFile,
        "Prime worker TLS private key",
        false,
      ),
      clientCertificateAuthority: readText(
        this.options.workerClientCaFile,
        "Prime worker client CA",
      ),
      registryAuthentication: readSecret(
        this.options.registryAuthFile,
        "Prime worker registry authentication",
        false,
      ),
    });
    record = {
      schemaVersion: "openpond.primeWorkerBootstrap.v1",
      runId: input.runId,
      computeLeaseId: input.lease.id,
      workerImageDigest: input.workerImageDigest,
      receipt,
    };
    try {
      await this.save(record);
      const connected = this.adapter(input, record);
      await connected.capabilities();
      return connected;
    } catch (error) {
      await this.bootstrapper
        .destroy({ ...connection, receipt })
        .catch(() => undefined);
      await this.remove(input.runId);
      throw error;
    }
  }

  async release(input: {
    runId: string;
    lease: ComputeLease;
    workerImageDigest: string;
  }): Promise<void> {
    const record = await this.load(input.runId);
    if (!record) return;
    assertBootstrapRecord(record, input);
    try {
      await this.bootstrapper.destroy({
        ...sshConnection(input.lease),
        receipt: record.receipt,
      });
    } finally {
      await this.remove(input.runId);
    }
  }

  private adapter(
    input: {
      runId: string;
      lease: ComputeLease;
      workerImageDigest: string;
    },
    record: BootstrapRecord,
  ): ConnectedTrainingEngineAdapter {
    const identityKey = readSecret(
      this.options.identityKeyFile,
      "Prime worker identity key",
    );
    const transport = new HttpConnectedWorkerTransport(
      new URL(record.receipt.workerEndpoint),
      createMtlsWorkerFetch({
        clientCertificate: readText(
          this.options.clientCertificateFile,
          "Prime client certificate",
        ),
        clientPrivateKey: readSecret(
          this.options.clientPrivateKeyFile,
          "Prime client private key",
          false,
        ),
        serverCertificateAuthority: readText(
          this.options.serverCaFile,
          "Prime server CA",
        ),
        serverName: this.options.tlsServerName,
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
            const actual = Buffer.from(signature, "hex");
            return (
              actual.byteLength === expected.byteLength &&
              timingSafeEqual(actual, expected)
            );
          },
        },
        {
          clientRelease: "0.0.38",
          expectedWorkerImageDigest: input.workerImageDigest,
          secretLeaseRef: readSecret(
            this.options.authenticationLeaseFile,
            "Prime worker authentication lease",
          ),
          nonce: () => randomBytes(32).toString("hex"),
        },
      ),
      {
        id: "connected-prime-rl",
        artifactDirectory: path.join(
          this.options.storeDir,
          "training",
          "connected-artifacts",
        ),
        resolvedBundle: (plan) =>
          resolveLocalConnectedWorkerBundle({
            storeDir: this.options.storeDir,
            plan,
          }),
      },
    );
  }

  private async save(record: BootstrapRecord): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const target = this.path(record.runId);
    const serialized = `${JSON.stringify(record, null, 2)}\n`;
    const current = await readFile(target, "utf8").catch(() => null);
    if (current !== null) {
      if (current !== serialized) {
        throw new Error("Prime worker bootstrap receipt changed.");
      }
      return;
    }
    const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(temporary, serialized, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, target).catch(async (error) => {
      await rm(temporary, { force: true });
      if ((await readFile(target, "utf8").catch(() => null)) !== serialized) {
        throw error;
      }
    });
  }

  private async load(runId: string): Promise<BootstrapRecord | null> {
    const value = await readFile(this.path(runId), "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      },
    );
    if (value === null) return null;
    const record = JSON.parse(value) as BootstrapRecord;
    if (
      record.schemaVersion !== "openpond.primeWorkerBootstrap.v1" ||
      record.runId !== runId
    ) {
      throw new Error("Prime worker bootstrap receipt is invalid.");
    }
    return record;
  }

  private remove(runId: string): Promise<void> {
    return rm(this.path(runId), { force: true });
  }

  private path(runId: string): string {
    return path.join(this.root, `${contentHash(runId)}.json`);
  }
}

function primeWorkerCapabilities(
  capabilityReceipt: string,
): Promise<TrainingEngineCapabilities> {
  return Promise.resolve(
    TrainingEngineCapabilitiesSchema.parse({
      schemaVersion: "openpond.trainingEngineCapabilities.v1",
      adapterId: "connected-prime-rl",
      available: true,
      methods: ["grpo"],
      signalKinds: [
        "trajectory",
        "reward",
        "grader_evidence",
        "infrastructure_failure",
      ],
      modelFamilies: ["transformers"],
      precisions: ["fp16", "bf16", "tf32"],
      topologies: ["single_worker", "single_gpu_phased"],
      workerProtocolVersion: "openpond.connectedWorker.v1",
      upstreamRevision: PRIME_RL_REVISION,
      capabilityReceipt,
      checkedAt: new Date().toISOString(),
      unavailableReason: null,
    }),
  );
}

function sshConnection(lease: ComputeLease): {
  host: string;
  port: number;
  user: string;
  knownHostFingerprint: string;
} {
  const connection = lease.connection;
  if (
    connection.transport !== "ssh" ||
    typeof connection.host !== "string" ||
    typeof connection.port !== "number" ||
    !Number.isInteger(connection.port) ||
    typeof connection.user !== "string" ||
    typeof connection.sshHostFingerprint !== "string"
  ) {
    throw new Error("Prime compute lease is not SSH-reachable.");
  }
  return {
    host: connection.host,
    port: connection.port,
    user: connection.user,
    knownHostFingerprint: connection.sshHostFingerprint,
  };
}

function assertBootstrapRecord(
  record: BootstrapRecord,
  input: {
    runId: string;
    lease: ComputeLease;
    workerImageDigest: string;
  },
): void {
  if (
    record.runId !== input.runId ||
    record.computeLeaseId !== input.lease.id ||
    record.workerImageDigest !== input.workerImageDigest
  ) {
    throw new Error("Prime worker bootstrap lineage changed.");
  }
}

function integerSetting(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (
    !Number.isInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    throw new Error(`Prime raw compute ${label} is invalid.`);
  }
  return parsed;
}

function readSecret(
  file: string,
  label: string,
  trim = true,
): string {
  requirePrivateFile(file, label);
  const value = readFileSync(file, "utf8");
  if (!value.trim()) throw new Error(`${label} file is empty.`);
  return trim ? value.trim() : value;
}

function readText(file: string, label: string): string {
  requireRegularFile(file, label);
  const value = readFileSync(file, "utf8");
  if (!value.trim()) throw new Error(`${label} file is empty.`);
  return value;
}

function requirePrivateFile(file: string, label: string): void {
  const metadata = requireRegularFile(file, label);
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(
      `${label} file must not be readable or writable by group or other users.`,
    );
  }
}

function requireRegularFile(
  file: string,
  label: string,
): Stats {
  const metadata = lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(
      `${label} must be a regular non-symlink file.`,
    );
  }
  return metadata;
}
