import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { contentHash } from "@openpond/taskset-sdk";

const MAX_PROCESS_OUTPUT_BYTES = 256 * 1024;
const FIREWORKS_API_BASE_URL = "https://api.fireworks.ai";
const EVALUATOR_READY_TIMEOUT_MS = 180_000;
const EVALUATOR_POLL_INTERVAL_MS = 2_000;

export type FireworksRftEvaluatorProvisioner = (input: {
  accountId: string;
  apiKey: string;
  baseModelId: string;
  publicBaseUrl: string;
  directory: string;
}) => Promise<{
  evaluatorId: string;
  evaluatorName: string;
  sourceHash: string;
  publicBaseUrl: string;
}>;

export async function provisionFireworksRftEvaluator(input: {
  accountId: string;
  apiKey: string;
  baseModelId: string;
  publicBaseUrl: string;
  directory: string;
}): Promise<{
  evaluatorId: string;
  evaluatorName: string;
  sourceHash: string;
  publicBaseUrl: string;
}> {
  const publicBaseUrl = validateFireworksRftPublicBaseUrl(input.publicBaseUrl);
  const source = evaluatorSource(publicBaseUrl, input.baseModelId);
  const sourceHash = contentHash({
    source,
    requirements: "eval-protocol\n",
    fixture: evaluatorFixture(),
  });
  const evaluatorId = `op-cso-remote-${sourceHash.slice(0, 16)}`;
  const evaluatorDirectory = path.join(input.directory, evaluatorId);
  await mkdir(evaluatorDirectory, { recursive: true });
  await Promise.all([
    writeFile(path.join(evaluatorDirectory, "test_openpond_remote.py"), source, { mode: 0o600 }),
    writeFile(path.join(evaluatorDirectory, "requirements.txt"), "eval-protocol\n", { mode: 0o600 }),
    writeFile(path.join(evaluatorDirectory, "fixture.jsonl"), evaluatorFixture(), { mode: 0o600 }),
  ]);
  const secretDirectory = await mkdtemp(path.join(tmpdir(), "openpond-rft-secret-"));
  const secretEnvPath = path.join(secretDirectory, ".env");
  await writeFile(
    secretEnvPath,
    `EP_REMOTE_API_KEY=${JSON.stringify(input.apiKey)}\n`,
    { mode: 0o600 },
  );
  let uploadOutput: string;
  try {
    uploadOutput = await runEvalProtocol({
      args: [
        "--from",
        "eval-protocol",
        "eval-protocol",
        "upload",
        "--path",
        evaluatorDirectory,
        "--entry",
        "test_openpond_remote.py::openpond_cross_system_reward",
        "--env-file",
        secretEnvPath,
        "--yes",
        "--force",
        "--evaluator-id",
        evaluatorId,
        "--evaluator-display-name",
        "OpenPond Cross-System remote reward",
        "--evaluator-description",
        "Delegates bounded multi-turn rollout and source-owned deterministic reward to OpenPond.",
      ],
      apiKey: input.apiKey,
      cwd: evaluatorDirectory,
    });
  } finally {
    await rm(secretDirectory, { recursive: true, force: true });
  }
  const uploadedEvaluatorId = resolveFireworksRftEvaluatorId(uploadOutput, evaluatorId);
  await waitForFireworksEvaluator({
    accountId: input.accountId,
    apiKey: input.apiKey,
    evaluatorId: uploadedEvaluatorId,
  });
  return {
    evaluatorId: uploadedEvaluatorId,
    evaluatorName: `accounts/${input.accountId}/evaluators/${uploadedEvaluatorId}`,
    sourceHash,
    publicBaseUrl,
  };
}

async function waitForFireworksEvaluator(input: {
  accountId: string;
  apiKey: string;
  evaluatorId: string;
}): Promise<void> {
  const deadline = Date.now() + EVALUATOR_READY_TIMEOUT_MS;
  const endpoint =
    `${FIREWORKS_API_BASE_URL}/v1/accounts/${encodeURIComponent(input.accountId)}` +
    `/evaluators/${encodeURIComponent(input.evaluatorId)}`;
  while (Date.now() < deadline) {
    const response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${input.apiKey}` },
    });
    const payload = await boundedJson(response);
    const state = typeof payload.state === "string" ? payload.state : null;
    if (response.ok && state === "ACTIVE") return;
    if (
      state === "BUILD_FAILED" ||
      state === "FAILED" ||
      (response.status !== 404 && !response.ok)
    ) {
      throw new Error(
        `Fireworks evaluator ${input.evaluatorId} failed readiness (${response.status}, ${state ?? "unknown"}): ${boundedProviderError(payload)}`,
      );
    }
    await delay(EVALUATOR_POLL_INTERVAL_MS);
  }
  throw new Error(
    `Fireworks evaluator ${input.evaluatorId} did not become ACTIVE within ${EVALUATOR_READY_TIMEOUT_MS / 1_000} seconds.`,
  );
}

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAX_PROCESS_OUTPUT_BYTES) {
    throw new Error("Fireworks evaluator status response exceeded 256 KiB.");
  }
  try {
    const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return { error: bytes.toString("utf8").slice(0, 2_000) };
  }
}

function boundedProviderError(payload: Record<string, unknown>): string {
  return JSON.stringify(payload)
    .replace(/(?:fw|sk)[_-][A-Za-z0-9_-]{8,}/g, "[REDACTED]")
    .slice(0, 2_000);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

function evaluatorSource(
  publicBaseUrl: string,
  baseModelId: string,
): string {
  return `import os
from pathlib import Path

from eval_protocol.models import EvaluateResult, EvaluationRow
from eval_protocol.pytest import RemoteRolloutProcessor, evaluation_test


@evaluation_test(
    input_dataset=[str(Path(__file__).parent / "fixture.jsonl")],
    completion_params=[{
        "model": ${JSON.stringify(`fireworks_ai/${baseModelId}`)},
        "temperature": 0.8,
    }],
    rollout_processor=RemoteRolloutProcessor(
        remote_base_url=${JSON.stringify(publicBaseUrl)},
        timeout_seconds=180.0,
    ),
    passed_threshold=0.75,
    max_dataset_rows=1,
    num_runs=1,
    mode="pointwise",
)
async def openpond_cross_system_reward(row: EvaluationRow) -> EvaluationRow:
    if not os.environ.get("EP_REMOTE_API_KEY"):
        raise RuntimeError("EP_REMOTE_API_KEY is required for OpenPond callback authentication.")
    extra = row.execution_metadata.extra or {}
    reward = extra.get("reward")
    eligible = extra.get("reward_eligible") is True
    valid = eligible and isinstance(reward, (int, float)) and 0.0 <= float(reward) <= 1.15
    row.evaluation_result = EvaluateResult(
        score=float(reward) if valid else 0.0,
        reason=(
            f"OpenPond canonical receipt {extra.get('receipt_id', 'missing')} "
            f"outcome={extra.get('outcome', 'unavailable')}"
        ),
        is_score_valid=valid,
    )
    return row
`;
}

function evaluatorFixture(): string {
  return `${JSON.stringify({
    messages: [{ role: "user", content: "OpenPond evaluator upload validation fixture." }],
    input_metadata: {
      row_id: "openpond-upload-fixture",
      dataset_info: { local_validation_only: true },
    },
  })}\n`;
}

export function validateFireworksRftPublicBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Fireworks RFT requires a valid public HTTPS callback URL.");
  }
  if (url.protocol !== "https:") {
    throw new Error("Fireworks RFT requires a public HTTPS callback URL.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Fireworks RFT callback URL cannot contain credentials, query, or fragment.");
  }
  if (!url.pathname.endsWith("/v1/training/fireworks/rft")) {
    throw new Error(
      "Fireworks RFT callback URL must end with /v1/training/fireworks/rft.",
    );
  }
  return url.toString().replace(/\/$/, "");
}

export function resolveFireworksRftEvaluatorId(
  uploadOutput: string,
  requestedEvaluatorId: string,
): string {
  const uploaded = uploadOutput.match(
    /Successfully uploaded evaluator:\s*([a-z0-9][a-z0-9-]{0,127})/i,
  )?.[1];
  return uploaded ?? requestedEvaluatorId;
}

async function runEvalProtocol(input: {
  args: string[];
  apiKey: string;
  cwd: string;
}): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn("uvx", input.args, {
      cwd: input.cwd,
      env: evaluatorProcessEnvironment(input.apiKey),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output: Buffer[] = [];
    let size = 0;
    const append = (chunk: Buffer | string) => {
      if (size >= MAX_PROCESS_OUTPUT_BYTES) return;
      const bytes = Buffer.from(chunk);
      output.push(bytes.subarray(0, MAX_PROCESS_OUTPUT_BYTES - size));
      size += bytes.byteLength;
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      const detail = Buffer.concat(output)
        .toString("utf8")
        .replaceAll(input.apiKey, "[REDACTED]");
      if (code === 0) {
        resolve(detail);
        return;
      }
      reject(
        new Error(
          `Eval Protocol evaluator upload failed (${signal ?? code ?? "unknown"}): ${detail.slice(-8_000)}`,
        ),
      );
    });
  });
}

function evaluatorProcessEnvironment(apiKey: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    FIREWORKS_API_KEY: apiKey,
    EP_REMOTE_API_KEY: apiKey,
    PYTHONUNBUFFERED: "1",
  };
  for (const key of [
    "PATH",
    "HOME",
    "TMPDIR",
    "XDG_CACHE_HOME",
    "UV_CACHE_DIR",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "REQUESTS_CA_BUNDLE",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
  ]) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  return environment;
}
