import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { contentHash } from "@openpond/harness";
import type { TasksetRunManifest } from "@openpond/evals";
import type { CustomVerifierRunner } from "@openpond/evals/graders";
import { JavaScriptVerifierResultSchema } from "@openpond/evals/javascript-verifier";
import {
  decodeTasksetPackageFile,
  validateTasksetPackage,
  type TasksetPackage,
} from "openpond-sdk/taskset-packages";
import {
  HOST_STORAGE_CONTRACT_VERSION,
  HostStorageRequestSchema,
  type AgentHostStorageClient,
} from "@openpond/agent-runtime";
import { createCandidateCommandExecutor } from "../harness/experiment-candidate-command.js";

type Invocation = Parameters<CustomVerifierRunner>[0];
export type ProfileSandboxVerifier = (
  input: Omit<Invocation, "evidence"> & {
    evidence: Invocation["evidence"] & {
      artifacts?: unknown;
      caseOwner?: { sessionId: string; turnId: string; traceHash: string };
    };
    manifest?: TasksetRunManifest;
    packageValue: TasksetPackage;
    authorize(): Promise<void>;
    signal?: AbortSignal;
  },
) => Promise<ReturnType<typeof JavaScriptVerifierResultSchema.parse>>;

export const executeLocalProfileVerifier: ProfileSandboxVerifier = async (input) => {
  const value = validateTasksetPackage(input.packageValue);
  if (input.grader.runtime !== "sandbox_process")
    throw new Error("Select the sandbox process runtime for a local file grader.");
  if (!value.taskset.graders.some((g) => contentHash(g) === contentHash(input.grader)))
    throw new Error("The private grader differs from its package.");
  if (!value.taskset.tasks.some((task) => contentHash(task) === contentHash(input.task)))
    throw new Error("The private case differs from its package.");
  await input.authorize();
  input.signal?.throwIfAborted();
  const root = await mkdtemp(path.join(os.tmpdir(), "profile-private-grade-"));
  const identity = randomUUID();
  try {
    for (const file of value.files.filter((file) => file.asset.visibility !== "policy")) {
      const relative = file.asset.path;
      if (
        path.isAbsolute(relative) ||
        relative.split(/[\\/]/).some((p) => !p || p === "." || p === "..")
      )
        throw new Error("Private grader asset path invalid.");
      const destination = path.join(root, "package", relative);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, decodeTasksetPackageFile(file), { mode: 0o400 });
    }
    await writeFile(
      path.join(root, "request.json"),
      JSON.stringify({
        task: input.task,
        attempt: input.evidence,
        input: input.task.input,
        output: input.evidence.output,
        artifacts: "artifacts" in input.evidence ? input.evidence.artifacts : [],
        expectedOutput: input.task.expectedOutput,
      }),
      { mode: 0o400 },
    );
    const runner = `import fs from 'node:fs/promises'; const module=await import(${JSON.stringify("./package/" + input.grader.verifierRef.path)}); const result=await module[${JSON.stringify(input.grader.exportName ?? "verify")}](JSON.parse(await fs.readFile('request.json','utf8'))); console.log(JSON.stringify(result));`;
    await writeFile(path.join(root, "runner.mjs"), runner, { mode: 0o400 });
    const execute = createCandidateCommandExecutor({
      authorize: async () => {
        await input.authorize();
        input.signal?.throwIfAborted();
        return {
          candidateId: identity,
          candidateRevision: 1,
          ownerId: identity,
          sessionId: identity,
          turnId: identity,
          sourceRoot: root,
          writablePaths: [],
        };
      },
    });
    const result = await execute({
      candidateId: identity,
      sessionId: identity,
      turnId: identity,
      expectedRevision: 1,
      command: "/runtime/node --max-old-space-size=512 runner.mjs",
      timeoutMs: input.grader.timeoutMs,
      maxOutputBytes: 70000,
      signal: input.signal,
    });
    await input.authorize();
    input.signal?.throwIfAborted();
    if (result.code !== 0 || result.timedOut || result.stdoutTruncated || result.stderrTruncated)
      throw new Error("Private grading sandbox did not complete.");
    return JavaScriptVerifierResultSchema.parse(JSON.parse(result.stdout));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

export function createHostedProfileVerifier(
  client: AgentHostStorageClient,
): ProfileSandboxVerifier {
  return async (input) => {
    if (!input.manifest) throw new Error("The hosted grader requires its admitted manifest.");
    await input.authorize();
    input.signal?.throwIfAborted();
    const artifacts =
      "artifacts" in input.evidence && Array.isArray(input.evidence.artifacts)
        ? input.evidence.artifacts.map(
            ({ reference, title, contentType }: Record<string, unknown>) => ({
              reference,
              title,
              contentType,
            }),
          )
        : [];
    const owner =
      "caseOwner" in input.evidence
        ? (input.evidence.caseOwner as { sessionId: string; turnId: string })
        : null;
    if (!owner?.sessionId || !owner.turnId)
      throw new Error("The private grader has no sealed case owner.");
    const bytes = Buffer.from(
      JSON.stringify({
        manifest: input.manifest,
        packageValue: input.packageValue,
        graderId: input.grader.id,
        taskId: input.task.id,
        evidence: { ...input.evidence, artifacts },
      }),
    );
    if (bytes.length > 20000000)
      throw new Error("The private grading package exceeds its transport limit.");
    const params = {
      callId: randomUUID(),
      sessionId: owner.sessionId,
      turnId: owner.turnId,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.length,
      timeoutMs: input.grader.timeoutMs,
    };
    const request = (params: Record<string, unknown>, timeout = 120000) =>
      client.request(
        HostStorageRequestSchema.parse({
          contractVersion: HOST_STORAGE_CONTRACT_VERSION,
          requestId: randomUUID(),
          operation: "profile-evaluations/grade",
          params,
        }),
        timeout,
      );
    for (let offset = 0; offset < bytes.length; offset += 98304) {
      await input.authorize();
      input.signal?.throwIfAborted();
      await request({
        ...params,
        action: "upload",
        offset,
        contentsBase64: bytes.subarray(offset, offset + 98304).toString("base64"),
      });
    }
    const result = await request({ ...params, action: "execute" }, input.grader.timeoutMs + 120000);
    await input.authorize();
    input.signal?.throwIfAborted();
    return JavaScriptVerifierResultSchema.parse(result);
  };
}
