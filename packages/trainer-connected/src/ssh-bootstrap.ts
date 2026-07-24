import { createHash } from "node:crypto";

export interface SshCommandRunner {
  run(input: {
    host: string;
    port: number;
    user: string;
    knownHostFingerprint: string;
    command: string[];
    stdin?: string;
  }): Promise<{ code: number; stdout: string; stderr: string }>;
}

export type ConnectedWorkerBootstrapReceipt = {
  hostFingerprint: string;
  runtime: "docker" | "podman";
  imageDigest: string;
  containerId: string;
  workerEndpoint: string;
  stateVolume: string;
  secretDirectory: string | null;
};

export class SshConnectedWorkerBootstrapper {
  constructor(private readonly runner: SshCommandRunner) {}

  async bootstrap(input: {
    host: string;
    port: number;
    user: string;
    knownHostFingerprint: string;
    runtime: "docker" | "podman";
    imageRepository: string;
    imageDigest: string;
    workerPort: number;
    authenticationLeaseFile: string;
    workerId: string;
    workerRelease: string;
    capabilityReceipt: string;
    identityKeyFile: string;
    tlsCertificateFile: string;
    tlsPrivateKeyFile: string;
    clientCaFile: string;
    pullPolicy?: "always" | "never";
  }): Promise<ConnectedWorkerBootstrapReceipt> {
    if (!/^sha256:[a-f0-9]{64}$/.test(input.imageDigest)) {
      throw new Error("Connected worker image must be pinned by digest.");
    }
    if (!/^SHA256:[A-Za-z0-9+/=]+$/.test(input.knownHostFingerprint)) {
      throw new Error("Connected worker SSH host fingerprint is required.");
    }
    const image = `${input.imageRepository}@${input.imageDigest}`;
    const stateVolume = `openpond-worker-${createHash("sha256")
      .update(input.workerId)
      .digest("hex")
      .slice(0, 24)}`;
    const result = await this.runner.run({
      host: input.host,
      port: input.port,
      user: input.user,
      knownHostFingerprint: input.knownHostFingerprint,
      command: [
        input.runtime,
        "run",
        "--detach",
        "--rm",
        "--gpus",
        "all",
        "--publish",
        `${input.workerPort}:${input.workerPort}`,
        ...(input.pullPolicy
          ? ["--pull", input.pullPolicy]
          : []),
        "--env",
        `OPENPOND_WORKER_ID=${input.workerId}`,
        "--env",
        `OPENPOND_WORKER_RELEASE=${input.workerRelease}`,
        "--env",
        `OPENPOND_WORKER_IMAGE_DIGEST=${input.imageDigest}`,
        "--env",
        `OPENPOND_WORKER_CAPABILITY_RECEIPT=${input.capabilityReceipt}`,
        "--env",
        "OPENPOND_WORKER_ENGINE_ADAPTER_ID=connected-prime-rl",
        "--env",
        "OPENPOND_WORKER_AUTHENTICATION_LEASE_FILE=/run/openpond/authentication-lease",
        "--env",
        "OPENPOND_WORKER_IDENTITY_KEY_FILE=/run/openpond/identity.key",
        "--mount",
        `type=bind,src=${input.authenticationLeaseFile},dst=/run/openpond/authentication-lease,readonly`,
        "--mount",
        `type=bind,src=${input.identityKeyFile},dst=/run/openpond/identity.key,readonly`,
        "--mount",
        `type=bind,src=${input.tlsCertificateFile},dst=/run/openpond/tls.crt,readonly`,
        "--mount",
        `type=bind,src=${input.tlsPrivateKeyFile},dst=/run/openpond/tls.key,readonly`,
        "--mount",
        `type=bind,src=${input.clientCaFile},dst=/run/openpond/client-ca.crt,readonly`,
        "--mount",
        `type=volume,src=${stateVolume},dst=/var/lib/openpond-worker`,
        image,
        "--port",
        String(input.workerPort),
        "--tls-certificate",
        "/run/openpond/tls.crt",
        "--tls-private-key",
        "/run/openpond/tls.key",
        "--client-ca",
        "/run/openpond/client-ca.crt",
      ],
    });
    if (result.code !== 0) {
      throw new Error(
        `Connected worker bootstrap failed: ${result.stderr.trim() || "unknown error"}`,
      );
    }
    const containerId = result.stdout.trim().split(/\s+/)[0];
    if (!containerId) throw new Error("Worker bootstrap returned no container ID.");
    return {
      hostFingerprint: input.knownHostFingerprint,
      runtime: input.runtime,
      imageDigest: input.imageDigest,
      containerId,
      workerEndpoint: `https://${input.host}:${input.workerPort}`,
      stateVolume,
      secretDirectory: null,
    };
  }

  async bootstrapWithSecrets(input: {
    host: string;
    port: number;
    user: string;
    knownHostFingerprint: string;
    runtime: "docker" | "podman";
    imageRepository: string;
    imageDigest: string;
    workerPort: number;
    authenticationLease: string;
    workerId: string;
    workerRelease: string;
    capabilityReceipt: string;
    identityKey: string;
    tlsCertificate: string;
    tlsPrivateKey: string;
    clientCertificateAuthority: string;
    registryAuthentication?: string;
  }): Promise<ConnectedWorkerBootstrapReceipt> {
    for (const [label, value] of [
      ["authentication lease", input.authenticationLease],
      ["identity key", input.identityKey],
      ["TLS certificate", input.tlsCertificate],
      ["TLS private key", input.tlsPrivateKey],
      ["client certificate authority", input.clientCertificateAuthority],
      ...(input.registryAuthentication === undefined
        ? []
        : [["registry authentication", input.registryAuthentication] as const]),
    ] as const) {
      if (!value.trim()) {
        throw new Error(`Connected worker ${label} is empty.`);
      }
    }
    const secretDirectory = `/var/lib/openpond-worker-secrets/${createHash(
      "sha256",
    )
      .update(input.workerId)
      .digest("hex")
      .slice(0, 24)}`;
    await this.requireSuccess(input, [
      "install",
      "-d",
      "-m",
      "0700",
      secretDirectory,
    ], "secret directory creation");
    const files = [
      ["authentication-lease", input.authenticationLease],
      ["identity.key", input.identityKey],
      ["tls.crt", input.tlsCertificate],
      ["tls.key", input.tlsPrivateKey],
      ["client-ca.crt", input.clientCertificateAuthority],
    ] as const;
    try {
      for (const [name, value] of files) {
        await this.requireSuccess(
          input,
          [
            "sh",
            "-c",
            'umask 077; cat > "$1"',
            "openpond-secret-stage",
            `${secretDirectory}/${name}`,
          ],
          `${name} staging`,
          value,
        );
      }
      if (input.registryAuthentication !== undefined) {
        const registryDirectory = `${secretDirectory}/registry`;
        await this.requireSuccess(
          input,
          ["install", "-d", "-m", "0700", registryDirectory],
          "registry secret directory creation",
        );
        await this.requireSuccess(
          input,
          [
            "sh",
            "-c",
            'umask 077; cat > "$1"',
            "openpond-registry-stage",
            `${registryDirectory}/config.json`,
          ],
          "registry authentication staging",
          input.registryAuthentication,
        );
        await this.requireSuccess(
          input,
          [
            "env",
            `DOCKER_CONFIG=${registryDirectory}`,
            input.runtime,
            "pull",
            `${input.imageRepository}@${input.imageDigest}`,
          ],
          "immutable worker image pull",
        );
      }
      const receipt = await this.bootstrap({
        host: input.host,
        port: input.port,
        user: input.user,
        knownHostFingerprint: input.knownHostFingerprint,
        runtime: input.runtime,
        imageRepository: input.imageRepository,
        imageDigest: input.imageDigest,
        workerPort: input.workerPort,
        authenticationLeaseFile:
          `${secretDirectory}/authentication-lease`,
        workerId: input.workerId,
        workerRelease: input.workerRelease,
        capabilityReceipt: input.capabilityReceipt,
        identityKeyFile: `${secretDirectory}/identity.key`,
        tlsCertificateFile: `${secretDirectory}/tls.crt`,
        tlsPrivateKeyFile: `${secretDirectory}/tls.key`,
        clientCaFile: `${secretDirectory}/client-ca.crt`,
        pullPolicy:
          input.registryAuthentication === undefined
            ? "always"
            : "never",
      });
      return { ...receipt, secretDirectory };
    } catch (error) {
      await this.cleanupSecrets(input, secretDirectory).catch(
        () => undefined,
      );
      throw error;
    }
  }

  async destroy(input: {
    host: string;
    port: number;
    user: string;
    knownHostFingerprint: string;
    receipt: ConnectedWorkerBootstrapReceipt;
    removeStateVolume?: boolean;
  }): Promise<void> {
    if (input.receipt.hostFingerprint !== input.knownHostFingerprint) {
      throw new Error(
        "Connected worker cleanup SSH host fingerprint changed.",
      );
    }
    const errors: unknown[] = [];
    await this.requireSuccess(
      input,
      [
        input.receipt.runtime,
        "rm",
        "--force",
        input.receipt.containerId,
      ],
      "container removal",
    ).catch((error) => {
      if (!missingContainer(error)) errors.push(error);
    });
    if (input.receipt.secretDirectory) {
      await this.cleanupSecrets(input, input.receipt.secretDirectory)
        .catch((error) => errors.push(error));
    }
    if (input.removeStateVolume) {
      await this.requireSuccess(
        input,
        [
          input.receipt.runtime,
          "volume",
          "rm",
          "--force",
          input.receipt.stateVolume,
        ],
        "state-volume removal",
      ).catch((error) => errors.push(error));
    }
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        "Connected worker cleanup failed.",
      );
    }
  }

  private async cleanupSecrets(
    connection: {
      host: string;
      port: number;
      user: string;
      knownHostFingerprint: string;
    },
    secretDirectory: string,
  ): Promise<void> {
    if (
      !/^\/var\/lib\/openpond-worker-secrets\/[a-f0-9]{24}$/.test(
        secretDirectory,
      )
    ) {
      throw new Error("Connected worker secret directory is invalid.");
    }
    await this.requireSuccess(
      connection,
      ["rm", "-rf", "--", secretDirectory],
      "secret cleanup",
    );
  }

  private async requireSuccess(
    connection: {
      host: string;
      port: number;
      user: string;
      knownHostFingerprint: string;
    },
    command: string[],
    operation: string,
    stdin?: string,
  ): Promise<void> {
    const result = await this.runner.run({
      ...connection,
      command,
      stdin,
    });
    if (result.code !== 0) {
      throw new Error(
        `Connected worker ${operation} failed: ${
          result.stderr.trim() || "unknown error"
        }`,
      );
    }
  }
}

function missingContainer(error: unknown): boolean {
  return (
    error instanceof Error &&
    /(?:no such container|no container with (?:name|id)|container .* not found)/i
      .test(error.message)
  );
}
