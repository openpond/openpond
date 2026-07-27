import { spawn, type ChildProcess } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { PrimeSshKey } from "@openpond/compute-provider-prime";

const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

export async function resolvePrimeSshIdentity(
  providerKeys: PrimeSshKey[],
): Promise<{ sshKeyId: string; privateKeyPath: string }> {
  const sshDirectory = path.join(os.homedir(), ".ssh");
  const localKeys = [];
  for (const entry of await readdir(sshDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".pub")) continue;
    const publicKeyPath = path.join(sshDirectory, entry.name);
    const privateKeyPath = publicKeyPath.slice(0, -4);
    let privateInfo;
    try {
      privateInfo = await lstat(privateKeyPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (
      !privateInfo.isFile()
      || privateInfo.isSymbolicLink()
      || (privateInfo.mode & 0o077) !== 0
    ) {
      continue;
    }
    localKeys.push({
      normalized: normalizePublicKey(await readFile(publicKeyPath, "utf8")),
      privateKeyPath,
    });
  }
  const orderedProviderKeys = [...providerKeys].sort(
    (left, right) =>
      Number(right.isPrimary) - Number(left.isPrimary)
      || left.id.localeCompare(right.id),
  );
  for (const providerKey of orderedProviderKeys) {
    const local = localKeys.find(
      (candidate) =>
        candidate.normalized === normalizePublicKey(providerKey.publicKey),
    );
    if (local) {
      return {
        sshKeyId: providerKey.id,
        privateKeyPath: local.privateKeyPath,
      };
    }
  }
  throw new Error(
    "No local private SSH key matches a registered Prime Intellect public key.",
  );
}

export async function createPrimeRolloutSshTransport(input: {
  host: string;
  port: number;
  user: string;
  expectedFingerprint: string;
  privateKeyPath: string;
  artifactRoot: string;
}) {
  await mkdir(input.artifactRoot, { recursive: true, mode: 0o700 });
  const scan = await runCapture("ssh-keyscan", [
    "-T",
    "15",
    "-p",
    String(input.port),
    "--",
    input.host,
  ]);
  if (scan.code !== 0 || !scan.stdout.trim()) {
    throw new Error(
      scan.stderr.trim() || "Prime SSH host-key scan returned no keys.",
    );
  }
  const matchingLines: string[] = [];
  for (const [index, line] of scan.stdout
    .split(/\r?\n/)
    .filter((candidate) => candidate.trim() && !candidate.startsWith("#"))
    .entries()) {
    const candidatePath = path.join(
      input.artifactRoot,
      `known-host-candidate-${index}`,
    );
    await writeFile(candidatePath, `${line}\n`, { mode: 0o600 });
    const fingerprint = await runCapture("ssh-keygen", [
      "-E",
      "sha256",
      "-lf",
      candidatePath,
    ]);
    if (
      fingerprint.code === 0
      && fingerprint.stdout
        .split(/\s+/)
        .includes(input.expectedFingerprint)
    ) {
      matchingLines.push(line);
    }
  }
  if (!matchingLines.length) {
    throw new Error("Prime SSH host fingerprint changed before upload.");
  }
  const knownHostsPath = path.join(input.artifactRoot, "known_hosts");
  await writeFile(
    knownHostsPath,
    `${matchingLines.join("\n")}\n`,
    { mode: 0o600 },
  );
  const commonSshArgs = [
    "-p",
    String(input.port),
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=20",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    `IdentityFile=${input.privateKeyPath}`,
    "-o",
    `UserKnownHostsFile=${knownHostsPath}`,
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "LogLevel=ERROR",
  ];
  const target = `${input.user}@${input.host}`;

  async function runRemote(
    command: string[],
    options: { timeoutMs?: number } = {},
  ): Promise<{ stdout: string; stderr: string }> {
    const result = await runCapture(
      "ssh",
      [
        ...commonSshArgs,
        "--",
        target,
        command.map(posixQuote).join(" "),
      ],
      options.timeoutMs,
    );
    if (result.code !== 0) {
      throw new Error(
        `Prime SSH command failed (${result.code}): ${result.stderr.slice(0, 4_000)}`,
      );
    }
    return result;
  }

  async function upload(
    localPaths: string[],
    remoteDirectory: string,
  ): Promise<void> {
    const result = await runCapture(
      "scp",
      [
        "-r",
        "-P",
        String(input.port),
        "-o",
        "BatchMode=yes",
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        `IdentityFile=${input.privateKeyPath}`,
        "-o",
        `UserKnownHostsFile=${knownHostsPath}`,
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "LogLevel=ERROR",
        "--",
        ...localPaths,
        `${target}:${remoteDirectory}`,
      ],
      10 * 60_000,
    );
    if (result.code !== 0) {
      throw new Error(
        `Prime SCP upload failed (${result.code}): ${result.stderr.slice(0, 4_000)}`,
      );
    }
  }

  async function download(
    remotePath: string,
    localDirectory: string,
  ): Promise<void> {
    const result = await runCapture(
      "scp",
      [
        "-P",
        String(input.port),
        "-o",
        "BatchMode=yes",
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        `IdentityFile=${input.privateKeyPath}`,
        "-o",
        `UserKnownHostsFile=${knownHostsPath}`,
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "LogLevel=ERROR",
        "--",
        `${target}:${remotePath}`,
        localDirectory,
      ],
      2 * 60_000,
    );
    if (result.code !== 0) {
      throw new Error(
        `Prime SCP download failed (${result.code}): ${result.stderr.slice(0, 4_000)}`,
      );
    }
  }

  async function downloadTree(
    remotePath: string,
    localDirectory: string,
  ): Promise<void> {
    const result = await runCapture(
      "scp",
      [
        "-r",
        "-P",
        String(input.port),
        "-o",
        "BatchMode=yes",
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        `IdentityFile=${input.privateKeyPath}`,
        "-o",
        `UserKnownHostsFile=${knownHostsPath}`,
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "LogLevel=ERROR",
        "--",
        `${target}:${remotePath}`,
        localDirectory,
      ],
      10 * 60_000,
    );
    if (result.code !== 0) {
      throw new Error(
        `Prime recursive SCP download failed (${result.code}): ${result.stderr.slice(0, 4_000)}`,
      );
    }
  }

  async function openTunnel(options: {
    localInferencePort: number;
    remoteInferencePort: number;
    localHarnessPort: number;
    remoteHarnessPort: number;
  }): Promise<{ process: ChildProcess; close(): Promise<void> }> {
    const child = spawn(
      "ssh",
      [
        ...commonSshArgs,
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
        "-N",
        "-L",
        `127.0.0.1:${options.localInferencePort}:127.0.0.1:${options.remoteInferencePort}`,
        "-R",
        `127.0.0.1:${options.remoteHarnessPort}:127.0.0.1:${options.localHarnessPort}`,
        "--",
        target,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4_000);
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 500);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(
          new Error(
            `Prime SSH tunnel exited before readiness (${code}): ${stderr}`,
          ),
        );
      });
    });
    return {
      process: child,
      async close() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            resolve();
          }, 5_000);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      },
    };
  }

  return {
    knownHostsPath,
    runRemote,
    upload,
    download,
    downloadTree,
    openTunnel,
  };
}

async function runCapture(
  command: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let settled = false;
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      timeout = null;
      reject(error);
    };
    let timeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      child.kill("SIGKILL");
      rejectOnce(new Error(`${command} exceeded ${timeoutMs}ms.`));
    }, timeoutMs);
    timeout.unref?.();
    const append = (target: Buffer[], chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_CAPTURE_BYTES) {
        child.kill("SIGKILL");
        rejectOnce(new Error(`${command} output exceeded its limit.`));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
    child.once("error", (error) => rejectOnce(error));
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      timeout = null;
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function normalizePublicKey(value: string): string {
  const parts = value.trim().split(/\s+/);
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    throw new Error("SSH public key is malformed.");
  }
  return `${parts[0]} ${parts[1]}`;
}

function posixQuote(value: string): string {
  if (value.includes("\0")) throw new Error("Remote SSH argument contains NUL.");
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}
