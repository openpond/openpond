import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  HOST_STORAGE_CONTRACT_VERSION,
  HostStorageRequestSchema,
  type AgentHostStorageClient,
} from "@openpond/agent-runtime";
import { sha256 } from "@openpond/harness";
import { z } from "zod";
import type { CandidateCommandReceipt } from "../harness/experiment-candidate-command.js";

export type ProfileCaseCommand = {
  sessionId: string;
  turnId: string;
  sourceRoot: string;
  publicHashes: Record<string, string>;
  runtimeRoot?: string;
  command: string;
  cwd?: string;
  stdin?: string;
  timeoutMs: number;
  signal: AbortSignal;
};
/** The host creates a fresh Work VM for each frozen case. No private source,
 * home directory, prior conversation workspace or model credential is copied. */
export function createHostedProfileCommandOwner(client: AgentHostStorageClient) {
  const uploaded = new Map<string, Set<string>>(),
    tails = new Map<string, Promise<unknown>>();
  async function serial<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    const next = (tails.get(sessionId) ?? Promise.resolve()).catch(() => undefined).then(action);
    tails.set(sessionId, next);
    try {
      return await next;
    } finally {
      if (tails.get(sessionId) === next) tails.delete(sessionId);
    }
  }
  const request = (params: Record<string, unknown>, timeout = 180000) =>
    client.request(
      HostStorageRequestSchema.parse({
        contractVersion: HOST_STORAGE_CONTRACT_VERSION,
        requestId: randomUUID(),
        operation: "profile-evaluations/sandbox",
        params,
      }),
      timeout,
    );
  async function upload(
    input: ProfileCaseCommand,
    area: "policy" | "runtime",
    relative: string,
    bytes: Buffer,
  ) {
    const hash = sha256(bytes),
      key = `${area}/${relative}/${hash}`,
      done = uploaded.get(input.sessionId) ?? new Set<string>();
    if (done.has(key)) return;
    if (bytes.length > 10000000)
      throw new Error("The public case file exceeds its admitted bound.");
    for (let offset = 0; offset === 0 || offset < bytes.length; offset += 98304) {
      input.signal.throwIfAborted();
      await request(
        {
          sessionId: input.sessionId,
          turnId: input.turnId,
          action: "upload",
          area,
          path: relative,
          sha256: hash,
          sizeBytes: bytes.length,
          offset,
          contentsBase64: bytes.subarray(offset, offset + 98304).toString("base64"),
        },
        300000,
      );
    }
    done.add(key);
    uploaded.set(input.sessionId, done);
  }
  async function runtimeFiles(root: string, relative = ""): Promise<string[]> {
    const result: string[] = [];
    for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      const name = path.posix.join(relative, entry.name);
      if (entry.isSymbolicLink()) {
        const actual = await fs.realpath(path.join(root, name));
        if (
          !actual.startsWith(`${await fs.realpath(root)}${path.sep}`) ||
          (await fs.stat(actual)).isDirectory()
        )
          throw new Error("The public Agent runtime symlink escapes its file closure.");
        result.push(name);
        continue;
      }
      if (entry.isDirectory()) result.push(...(await runtimeFiles(root, name)));
      else if (entry.isFile()) result.push(name);
      if (result.length > 8192) throw new Error("The public Agent runtime exceeds the file limit.");
    }
    return result;
  }
  return {
    execute: (input: ProfileCaseCommand): Promise<CandidateCommandReceipt> =>
      serial(input.sessionId, async () => {
        input.signal.throwIfAborted();
        for (const [relative, hash] of Object.entries(input.publicHashes)) {
          const actual = await fs.realpath(path.join(input.sourceRoot, relative)),
            root = await fs.realpath(input.sourceRoot);
          if (!actual.startsWith(`${root}${path.sep}`))
            throw new Error("The public case file escaped its source root.");
          const bytes = await fs.readFile(actual);
          if (sha256(bytes) !== hash)
            throw new Error("The public case file changed before upload.");
          await upload(input, "policy", relative, bytes);
        }
        if (input.runtimeRoot)
          for (const relative of await runtimeFiles(input.runtimeRoot))
            await upload(
              input,
              "runtime",
              relative,
              await fs.readFile(path.join(input.runtimeRoot, relative)),
            );
        const relative = path.relative(input.sourceRoot, input.cwd ?? input.sourceRoot);
        if (relative.startsWith("..") || path.isAbsolute(relative))
          throw new Error("The command cwd escaped the admitted case.");
        const result = z
          .object({
            code: z.number().int().nullable(),
            stdout: z.string().max(750000),
            stderr: z.string().max(750000),
            timedOut: z.boolean(),
            stdoutTruncated: z.boolean(),
            stderrTruncated: z.boolean(),
          })
          .parse(
            await request(
              {
                sessionId: input.sessionId,
                turnId: input.turnId,
                action: "exec",
                command: input.command,
                stdin: input.stdin,
                cwd: relative.split(path.sep).join("/"),
                timeoutMs: input.timeoutMs,
              },
              input.timeoutMs + 15000,
            ),
          );
        input.signal.throwIfAborted();
        return result;
      }),
    readOutput: (input: { sessionId: string; turnId: string; path: string; signal: AbortSignal }) =>
      serial(input.sessionId, async () => {
        const selected = input.path
          .replace(/^\/workspace\/work\/outputs\//, "")
          .replace(/^outputs\//, "");
        if (
          !selected ||
          selected.startsWith("/") ||
          selected.split(/[\\/]/).some((part) => !part || part === "." || part === "..") ||
          selected.includes("\0")
        )
          throw new Error("Select one case output file.");
        const chunks: Buffer[] = [];
        let size: number | null = null,
          hash: string | null = null;
        for (let offset = 0; size === null || offset < size; offset += 98304) {
          input.signal.throwIfAborted();
          const result = z
            .object({
              sizeBytes: z.number().int().min(1).max(10000000),
              sha256: z.string().regex(/^[a-f0-9]{64}$/),
              contentsBase64: z.string().max(131072),
            })
            .parse(
              await request(
                {
                  sessionId: input.sessionId,
                  turnId: input.turnId,
                  action: "read",
                  path: selected,
                  offset,
                },
                60000,
              ),
            );
          size ??= result.sizeBytes;
          hash ??= result.sha256;
          const bytes = Buffer.from(result.contentsBase64, "base64");
          if (
            result.sizeBytes !== size ||
            result.sha256 !== hash ||
            bytes.length !== Math.min(98304, size - offset) ||
            bytes.toString("base64") !== result.contentsBase64
          )
            throw new Error("The confined output changed during readback.");
          chunks.push(bytes);
        }
        const bytes = Buffer.concat(chunks);
        if (sha256(bytes) !== hash)
          throw new Error("The confined output differs from its saved byte identity.");
        input.signal.throwIfAborted();
        return { bytes, title: selected.split("/").at(-1)! };
      }),
    settle: (sessionId: string, turnId: string) =>
      serial(sessionId, async () => {
        try {
          await request({ sessionId, turnId, action: "stop" }, 60000);
        } finally {
          uploaded.delete(sessionId);
        }
      }),
  };
}
