import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const packageRoot = path.resolve(import.meta.dir, "..");

describe("negative validation examples", () => {
  test("documents and pins validation-blocking setup states", async () => {
    await withTempOutputDirectory(async (outputDirectory) => {
      const validation = await runSdkJsonAllowFailure([
        "validate",
        "--json",
        "--cwd",
        path.join(packageRoot, "examples", "validation-failures"),
        "--out-dir",
        outputDirectory,
      ]);
      expect(validation.exitCode).not.toBe(0);
      expect(validation.payload.status).toBe("failed");
      expect(issueCodes(validation.payload)).toEqual(expect.arrayContaining([
        "typescript_manifest_openpond_yaml_drift",
        "channel_missing_integration_requirement",
        "env_name_required",
        "volume_used_by_action_missing",
        "skill_generated_file_path_invalid",
        "eval_expected_artifact_not_declared",
      ]));
    });
  });

  test("documents and pins a failing publish-gate eval", async () => {
    await withTempOutputDirectory(async (outputDirectory) => {
      const evalResult = await runSdkJsonAllowFailure([
        "eval",
        "--json",
        "--cwd",
        path.join(packageRoot, "examples", "validation-failures", "eval-gate"),
        "--out-dir",
        outputDirectory,
      ]);
      expect(evalResult.exitCode).not.toBe(0);
      expect(evalResult.payload.summary).toMatchObject({ total: 1, passed: 0, failed: 1 });
      expect(evalResult.payload.publishGate).toMatchObject({
        status: "failed",
        total: 1,
        passed: 0,
        failed: 1,
        blockingFailures: ["fails-gate"],
      });
      expect(evalResult.payload.results[0]).toMatchObject({
        name: "fails-gate",
        status: "failed",
      });
    });
  });
});

type JsonPayload = Record<string, any>;

async function runSdkJsonAllowFailure(args: string[]) {
  const result = await runSdk(args);
  if (!result.stdout.trim()) throw new Error(formatFailure(args, result));
  return {
    exitCode: result.exitCode,
    payload: JSON.parse(result.stdout) as JsonPayload,
  };
}

async function runSdk(args: string[]) {
  const proc = Bun.spawn(["bun", "./dist/cli.js", ...args], {
    cwd: packageRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function withTempOutputDirectory(
  run: (outputDirectory: string) => Promise<void>,
): Promise<void> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openpond-agent-sdk-negative-"));
  try {
    await run(path.join(tempRoot, "output"));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function issueCodes(payload: JsonPayload) {
  return payload.issues.map((issue: { code: string }) => issue.code);
}

function formatFailure(
  args: string[],
  result: { stdout: string; stderr: string; exitCode: number },
) {
  return [
    `openpond-agent ${args.join(" ")} failed with exit code ${result.exitCode}`,
    result.stdout.trim(),
    result.stderr.trim(),
  ].filter(Boolean).join("\n");
}
