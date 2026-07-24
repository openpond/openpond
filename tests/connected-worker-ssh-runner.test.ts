import {
  SpawnSshCommandRunner,
  scanSshHostFingerprint,
  type LocalSshProcessRunner,
} from "../packages/trainer-connected/src/index.js";
import { describe, expect, test, vi } from "vitest";

describe("connected worker SSH command runner", () => {
  test("pins the scanned host key before executing a quoted command", async () => {
    const run = vi.fn<LocalSshProcessRunner["run"]>(
      async (input) => {
        if (input.command === "ssh-keyscan") {
          return {
            code: 0,
            stdout:
              "gpu.example.test ssh-ed25519 AAAA\n" +
              "gpu.example.test ssh-rsa BBBB\n",
            stderr: "",
          };
        }
        if (input.command === "ssh-keygen") {
          return {
            code: 0,
            stdout:
              input.args.at(-1)?.endsWith("-0")
                ? "256 SHA256:trusted= host (ED25519)\n"
                : "2048 SHA256:other= host (RSA)\n",
            stderr: "",
          };
        }
        return {
          code: 0,
          stdout: "container-id\n",
          stderr: "",
        };
      },
    );
    const runner = new SpawnSshCommandRunner({ run });
    const result = await runner.run({
      host: "gpu.example.test",
      port: 22,
      user: "openpond",
      knownHostFingerprint: "SHA256:trusted=",
      command: ["docker", "run", "value with spaces", "a'b"],
      stdin: "secret-over-stdin",
    });
    expect(result.code).toBe(0);
    const ssh = run.mock.calls.find(
      ([input]) => input.command === "ssh",
    )?.[0];
    expect(ssh?.args.at(-1)).toBe(
      "'docker' 'run' 'value with spaces' 'a'\\''b'",
    );
    expect(ssh?.stdin).toBe("secret-over-stdin");
    expect(ssh?.args.join(" ")).not.toContain(
      "secret-over-stdin",
    );
  });

  test("rejects a host-key mismatch without opening SSH", async () => {
    const run = vi.fn<LocalSshProcessRunner["run"]>(
      async (input) =>
        input.command === "ssh-keyscan"
          ? {
              code: 0,
              stdout: "gpu.example.test ssh-ed25519 AAAA\n",
              stderr: "",
            }
          : {
              code: 0,
              stdout: "256 SHA256:other= host (ED25519)\n",
              stderr: "",
            },
    );
    const result = await new SpawnSshCommandRunner({ run }).run({
      host: "gpu.example.test",
      port: 22,
      user: "openpond",
      knownHostFingerprint: "SHA256:trusted=",
      command: ["true"],
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/did not match/);
    expect(
      run.mock.calls.some(([input]) => input.command === "ssh"),
    ).toBe(false);
  });

  test("selects the strongest deterministic fingerprint for a fresh provider node", async () => {
    const run = vi.fn<LocalSshProcessRunner["run"]>(
      async (input) => {
        if (input.command === "ssh-keyscan") {
          return {
            code: 0,
            stdout:
              "gpu.example.test ssh-rsa BBBB\n" +
              "gpu.example.test ssh-ed25519 AAAA\n",
            stderr: "",
          };
        }
        return {
          code: 0,
          stdout: input.args.at(-1)?.endsWith("-1")
            ? "256 SHA256:ed25519= host (ED25519)\n"
            : "2048 SHA256:rsa= host (RSA)\n",
          stderr: "",
        };
      },
    );

    await expect(
      scanSshHostFingerprint({
        host: "gpu.example.test",
        port: 22,
        processRunner: { run },
      }),
    ).resolves.toBe("SHA256:ed25519=");
  });
});
