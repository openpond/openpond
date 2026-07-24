import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { SshCommandRunner } from "./ssh-bootstrap.js";

export interface LocalSshProcessRunner {
  run(input: {
    command: string;
    args: string[];
    stdin?: string;
  }): Promise<{ code: number; stdout: string; stderr: string }>;
}

export class SpawnLocalSshProcessRunner
  implements LocalSshProcessRunner
{
  async run(input: {
    command: string;
    args: string[];
    stdin?: string;
  }): Promise<{ code: number; stdout: string; stderr: string }> {
    const child = spawn(input.command, input.args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdin.end(input.stdin);
    const code = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (exitCode) => resolve(exitCode ?? 1));
    });
    return { code, stdout, stderr };
  }
}

export class SpawnSshCommandRunner implements SshCommandRunner {
  constructor(
    private readonly processRunner: LocalSshProcessRunner =
      new SpawnLocalSshProcessRunner(),
    private readonly options: {
      identityFile?: string;
    } = {},
  ) {}

  async run(
    input: Parameters<SshCommandRunner["run"]>[0],
  ): ReturnType<SshCommandRunner["run"]> {
    validateInput(input);
    const temporary = await mkdtemp(
      path.join(os.tmpdir(), "openpond-ssh-"),
    );
    try {
      const scan = await this.processRunner.run({
        command: "ssh-keyscan",
        args: [
          "-T",
          "10",
          "-p",
          String(input.port),
          "--",
          input.host,
        ],
      });
      if (scan.code !== 0 || !scan.stdout.trim()) {
        return {
          code: scan.code || 1,
          stdout: "",
          stderr:
            scan.stderr.trim() ||
            "Connected worker SSH host key scan failed.",
        };
      }
      const matchedKeys: string[] = [];
      for (const [index, line] of scan.stdout
        .split(/\r?\n/)
        .filter((candidate) => candidate.trim() && !candidate.startsWith("#"))
        .entries()) {
        const candidate = path.join(
          temporary,
          `known-host-candidate-${index}`,
        );
        await writeFile(candidate, `${line}\n`, {
          mode: 0o600,
        });
        const fingerprint = await this.processRunner.run({
          command: "ssh-keygen",
          args: ["-E", "sha256", "-lf", candidate],
        });
        if (
          fingerprint.code === 0 &&
          fingerprint.stdout
            .split(/\s+/)
            .includes(input.knownHostFingerprint)
        ) {
          matchedKeys.push(line);
        }
      }
      if (matchedKeys.length === 0) {
        return {
          code: 1,
          stdout: "",
          stderr:
            "Connected worker SSH host fingerprint did not match.",
        };
      }
      const knownHosts = path.join(temporary, "known_hosts");
      await writeFile(knownHosts, `${matchedKeys.join("\n")}\n`, {
        mode: 0o600,
      });
      const result = await this.processRunner.run({
        command: "ssh",
        args: [
          "-p",
          String(input.port),
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=15",
          "-o",
          `UserKnownHostsFile=${knownHosts}`,
          "-o",
          "StrictHostKeyChecking=yes",
          "-o",
          "LogLevel=ERROR",
          ...(this.options.identityFile
            ? [
                "-o",
                "IdentitiesOnly=yes",
                "-i",
                this.options.identityFile,
              ]
            : []),
          "--",
          `${input.user}@${input.host}`,
          input.command.map(posixQuote).join(" "),
        ],
        stdin: input.stdin,
      });
      // Force the file to be read before cleanup on unusual process runners.
      await readFile(knownHosts);
      return result;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}

export async function scanSshHostFingerprint(input: {
  host: string;
  port: number;
  processRunner?: LocalSshProcessRunner;
}): Promise<string> {
  validateInput({
    host: input.host,
    port: input.port,
    user: "openpond",
    knownHostFingerprint: "SHA256:placeholder",
    command: ["true"],
  });
  const runner =
    input.processRunner ?? new SpawnLocalSshProcessRunner();
  const scan = await runner.run({
    command: "ssh-keyscan",
    args: [
      "-T",
      "10",
      "-p",
      String(input.port),
      "--",
      input.host,
    ],
  });
  if (scan.code !== 0 || !scan.stdout.trim()) {
    throw new Error(
      scan.stderr.trim() ||
        "Connected worker SSH host key scan failed.",
    );
  }
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "openpond-host-key-"),
  );
  try {
    const fingerprints: Array<{
      algorithm: string;
      fingerprint: string;
    }> = [];
    for (const [index, line] of scan.stdout
      .split(/\r?\n/)
      .filter(
        (candidate) =>
          candidate.trim() && !candidate.startsWith("#"),
      )
      .entries()) {
      const candidate = path.join(temporary, `host-key-${index}`);
      await writeFile(candidate, `${line}\n`, { mode: 0o600 });
      const result = await runner.run({
        command: "ssh-keygen",
        args: ["-E", "sha256", "-lf", candidate],
      });
      const fingerprint = result.stdout.match(
        /SHA256:[A-Za-z0-9+/]+={0,2}/,
      )?.[0];
      const algorithm = line.trim().split(/\s+/)[1] ?? "";
      if (result.code === 0 && fingerprint) {
        fingerprints.push({ algorithm, fingerprint });
      }
    }
    const selected = fingerprints.sort(
      (left, right) =>
        hostKeyPriority(left.algorithm) -
          hostKeyPriority(right.algorithm) ||
        left.fingerprint.localeCompare(right.fingerprint),
    )[0];
    if (!selected) {
      throw new Error(
        "Connected worker SSH host scan returned no valid fingerprints.",
      );
    }
    return selected.fingerprint;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function hostKeyPriority(algorithm: string): number {
  if (algorithm === "ssh-ed25519") return 0;
  if (algorithm.startsWith("ecdsa-")) return 1;
  if (algorithm === "ssh-rsa") return 2;
  return 3;
}

function validateInput(
  input: Parameters<SshCommandRunner["run"]>[0],
): void {
  if (
    !input.host ||
    input.host.startsWith("-") ||
    /[\0\s]/.test(input.host)
  ) {
    throw new Error("Connected worker SSH host is invalid.");
  }
  if (!/^[A-Za-z_][A-Za-z0-9._-]{0,127}$/.test(input.user)) {
    throw new Error("Connected worker SSH user is invalid.");
  }
  if (
    !Number.isInteger(input.port) ||
    input.port < 1 ||
    input.port > 65_535
  ) {
    throw new Error("Connected worker SSH port is invalid.");
  }
  if (
    !/^SHA256:[A-Za-z0-9+/=]+$/.test(
      input.knownHostFingerprint,
    )
  ) {
    throw new Error(
      "Connected worker SSH host fingerprint is invalid.",
    );
  }
  if (
    input.command.length === 0 ||
    input.command.some((argument) => argument.includes("\0"))
  ) {
    throw new Error("Connected worker SSH command is invalid.");
  }
}

function posixQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
