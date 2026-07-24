import {
  SshConnectedWorkerBootstrapper,
  type SshCommandRunner,
} from "../packages/trainer-connected/src/index.js";
import { describe, expect, test, vi } from "vitest";

describe("connected worker SSH bootstrap", () => {
  test("mounts authentication material without exposing it in arguments", async () => {
    const run = vi.fn<SshCommandRunner["run"]>(async () => ({
      code: 0,
      stdout: "container-1\n",
      stderr: "",
    }));
    const bootstrapper = new SshConnectedWorkerBootstrapper({ run });
    const receipt = await bootstrapper.bootstrap({
      host: "gpu.example.test",
      port: 22,
      user: "openpond",
      knownHostFingerprint: "SHA256:fixture=",
      runtime: "docker",
      imageRepository: "registry.example.test/worker",
      imageDigest: `sha256:${"a".repeat(64)}`,
      workerPort: 7443,
      authenticationLeaseFile: "/run/openpond-host/authentication-lease",
      workerId: "worker-1",
      workerRelease: "0.0.38",
      capabilityReceipt: "b".repeat(64),
      identityKeyFile: "/run/openpond-host/identity.key",
      tlsCertificateFile: "/run/openpond-host/tls.crt",
      tlsPrivateKeyFile: "/run/openpond-host/tls.key",
      clientCaFile: "/run/openpond-host/client-ca.crt",
    });
    const command = run.mock.calls[0]![0].command;
    expect(command.join(" ")).not.toContain("opaque-lease-value");
    expect(command).toContain(
      "OPENPOND_WORKER_AUTHENTICATION_LEASE_FILE=/run/openpond/authentication-lease",
    );
    expect(command).toContain(
      "type=bind,src=/run/openpond-host/authentication-lease,dst=/run/openpond/authentication-lease,readonly",
    );
    expect(command.some((item) => item.startsWith("openpond.auth-lease=")))
      .toBe(false);
    expect(command).toContain(
      `type=volume,src=${receipt.stateVolume},dst=/var/lib/openpond-worker`,
    );
    expect(receipt.stateVolume).toMatch(
      /^openpond-worker-[a-f0-9]{24}$/,
    );
  });

  test("stages per-run secrets over verified SSH and removes them during cleanup", async () => {
    const run = vi.fn<SshCommandRunner["run"]>(async (input) => ({
      code: 0,
      stdout:
        input.command[0] === "docker" &&
        input.command[1] === "run"
          ? "container-2\n"
          : "",
      stderr: "",
    }));
    const bootstrapper = new SshConnectedWorkerBootstrapper({ run });
    const receipt = await bootstrapper.bootstrapWithSecrets({
      host: "gpu.example.test",
      port: 22,
      user: "openpond",
      knownHostFingerprint: "SHA256:fixture=",
      runtime: "docker",
      imageRepository: "registry.example.test/worker",
      imageDigest: `sha256:${"a".repeat(64)}`,
      workerPort: 7443,
      authenticationLease: "opaque-authentication-lease",
      workerId: "worker-2",
      workerRelease: "0.0.38",
      capabilityReceipt: "b".repeat(64),
      identityKey: "identity-key-secret",
      tlsCertificate: "certificate",
      tlsPrivateKey: "private-key-secret",
      clientCertificateAuthority: "client-ca",
      registryAuthentication: '{"auths":{"registry.example.test":{"auth":"secret"}}}',
    });

    expect(receipt.secretDirectory).toMatch(
      /^\/var\/lib\/openpond-worker-secrets\/[a-f0-9]{24}$/,
    );
    const serializedCommands = run.mock.calls
      .map(([input]) => input.command.join(" "))
      .join("\n");
    expect(serializedCommands).not.toContain(
      "opaque-authentication-lease",
    );
    expect(serializedCommands).not.toContain("private-key-secret");
    expect(serializedCommands).not.toContain(
      '"auth":"secret"',
    );
    expect(
      run.mock.calls.some(
        ([input]) => input.stdin === "opaque-authentication-lease",
      ),
    ).toBe(true);
    expect(
      run.mock.calls.some(
        ([input]) =>
          input.command[0] === "env" &&
          input.command.includes("pull") &&
          input.stdin === undefined,
      ),
    ).toBe(true);
    expect(
      run.mock.calls.some(
        ([input]) =>
          input.stdin?.includes('"auth":"secret"') ?? false,
      ),
    ).toBe(true);

    await bootstrapper.destroy({
      host: "gpu.example.test",
      port: 22,
      user: "openpond",
      knownHostFingerprint: "SHA256:fixture=",
      receipt,
    });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        command: [
          "rm",
          "-rf",
          "--",
          receipt.secretDirectory,
        ],
      }),
    );
  });

  test("still removes staged secrets when the ephemeral container has already exited", async () => {
    const run = vi.fn<SshCommandRunner["run"]>(async (input) => {
      if (
        input.command[0] === "docker" &&
        input.command[1] === "rm"
      ) {
        return {
          code: 1,
          stdout: "",
          stderr: "Error: No such container: container-2",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const bootstrapper = new SshConnectedWorkerBootstrapper({ run });

    await expect(
      bootstrapper.destroy({
        host: "gpu.example.test",
        port: 22,
        user: "openpond",
        knownHostFingerprint: "SHA256:fixture=",
        receipt: {
          hostFingerprint: "SHA256:fixture=",
          runtime: "docker",
          imageDigest: `sha256:${"a".repeat(64)}`,
          containerId: "container-2",
          workerEndpoint: "https://gpu.example.test:7443",
          stateVolume: "openpond-worker-fixture",
          secretDirectory:
            "/var/lib/openpond-worker-secrets/abcdef0123456789abcdef01",
        },
      }),
    ).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        command: [
          "rm",
          "-rf",
          "--",
          "/var/lib/openpond-worker-secrets/abcdef0123456789abcdef01",
        ],
      }),
    );
  });
});
