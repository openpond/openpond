import { createRewardRelease } from "../rewards.js";
import { createLearningTextAsset } from "../learning/assets.js";
import type { RewardAuthoringFields } from "../learning/reward-authoring.js";

export const PYTHON_CORRECTNESS_PRESET_VERSION = "python-stdio-correctness-1";
export const PYTHON_CORRECTNESS_DESCRIPTION = "Check explicitly admitted Python programs against owner-authored private stdin/stdout cases. Requires a pinned Python binary and fresh network, filesystem and process isolation. Missing code, tests or qualified runtime is unscorable; syntax alone is not correctness.";

/** This module runs only in an owner-admitted sandbox_process grader. Python -I
 * isolates Python configuration; bubblewrap separately isolates untrusted code.
 * The candidate receives each test input, never expected outputs or grader files. */
export const PYTHON_CORRECTNESS_VERIFIER_SOURCE = String.raw`
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
const unavailable = feedback => ({ score: null, passed: false, feedback, evidenceRefs: [] });
async function run(args, stdin = "", milliseconds = 2000) {
  return await new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/bwrap", args, { detached: true, env: {}, stdio: ["pipe", "pipe", "pipe"] });
    let chunks = [], bytes = 0, overflow = false, timedOut = false, settled = false;
    const kill = () => { if (child.pid) try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, milliseconds);
    const add = (data, retain) => { bytes += data.length; if (bytes > 65536) { overflow = true; kill(); } else if (retain) chunks.push(data); };
    child.stdout.on("data", data => add(data, true)); child.stderr.on("data", data => add(data, false));
    child.stdin.on("error", () => {});
    child.once("error", () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error("python_correctness_isolation_unavailable")); } });
    child.once("close", code => { clearTimeout(timer); kill(); if (!settled) { settled = true; resolve({ code, stdout: Buffer.concat(chunks).toString("utf8"), overflow, timedOut }); } });
    child.stdin.end(stdin);
  });
}
const isolation = ["--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--ro-bind", "/usr", "/usr", "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--tmpfs", "/case", "--clearenv", "--setenv", "PATH", "/usr/bin", "--chdir", "/case"];
export async function verify({ task, output, expectedOutput }) {
  const code = output?.pythonCode ?? output?.answer?.pythonCode;
  const criteria = expectedOutput?.pythonCorrectness;
  if (typeof code !== "string" || !code.trim() || Buffer.byteLength(code) > 65536) return unavailable("Python correctness requires a retained explicit pythonCode artifact of at most 64 KiB.");
  if (!criteria || criteria.schemaVersion !== "openpond.pythonStdioTests.v1" || !Array.isArray(criteria.tests) || !criteria.tests.length || criteria.tests.length > 20
      || criteria.tests.some(test => !test || typeof test.stdin !== "string" || typeof test.stdout !== "string" || Buffer.byteLength(test.stdin) > 65536 || Buffer.byteLength(test.stdout) > 65536))
    return unavailable("Python correctness requires owner-authored private stdin/stdout tests; a captured answer is not a reference.");
  const admission = criteria.runtime;
  if (!admission || admission.runtime !== "bubblewrap-python-stdio-v1" || !/^[a-f0-9]{64}$/.test(admission.pythonSha256 ?? ""))
    return unavailable("An owner-admitted pinned isolated Python runtime is required.");
  try {
    const binaryHash = createHash("sha256").update(await readFile("/usr/bin/python3")).digest("hex");
    if (binaryHash !== admission.pythonSha256) return unavailable("The admitted Python binary changed; qualify and pin the current runtime.");
    const probe = await run([...isolation, "--", "/usr/bin/python3", "-I", "-S", "-c", "import sys; print(sys.version_info.major)"]);
    if (probe.code !== 0 || probe.stdout.trim() !== "3" || probe.overflow || probe.timedOut) return unavailable("Python namespace isolation is unavailable in this runtime.");
  } catch { return unavailable("The pinned Python isolation runtime is unavailable."); }
  const directory = await mkdtemp(join(tmpdir(), "openpond-python-correctness-"));
  let passed = 0;
  try {
    const source = join(directory, "main.py"); await writeFile(source, code, { mode: 0o400 });
    for (const test of criteria.tests) {
      const result = await run([...isolation, "--ro-bind", source, "/case/main.py", "--", "/usr/bin/prlimit", "--as=268435456", "--cpu=2", "--fsize=65536", "--", "/usr/bin/python3", "-I", "-S", "/case/main.py"], test.stdin);
      if (result.code === 0 && !result.overflow && !result.timedOut && result.stdout === test.stdout) passed++;
    }
    return { score: passed / criteria.tests.length, passed: passed === criteria.tests.length,
      feedback: "Python correctness: " + passed + " of " + criteria.tests.length + " private tests passed.", evidenceRefs: [] };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
`;

export function pythonCorrectnessAuthoringFields(): Partial<RewardAuthoringFields> {
  return { kind: "custom_verifier", name: "Python correctness", description: PYTHON_CORRECTNESS_DESCRIPTION,
    feedbackKey: "python_correctness", code: PYTHON_CORRECTNESS_VERIFIER_SOURCE, exportName: "verify", timeout: "60000", verifierRuntime: "sandbox_process" };
}

/** Explicit owner publication may import these genuine immutable assets like
 * any other supplied grader. No publication, compute or capture happens here. */
export function createPythonCorrectnessPreset() {
  const asset = createLearningTextAsset({ text: PYTHON_CORRECTNESS_VERIFIER_SOURCE,
    path: "graders/openpond-python-stdio-correctness-v1.mjs", mediaType: "application/javascript", visibility: "verifier" });
  const reward = createRewardRelease({ schemaVersion: "openpond.rewardRelease.v1", id: "openpond-python-stdio-correctness", revision: 1,
    name: "Python correctness", description: PYTHON_CORRECTNESS_DESCRIPTION, feedbackKey: "python_correctness",
    implementation: { kind: "custom_verifier", runtime: "sandbox_process", verifierRef: asset.asset, exportName: "verify", timeoutMs: 60_000, networkPolicy: "none" },
    rawScore: { minimum: 0, maximum: 1 }, assets: [asset.asset] });
  return { reward, assets: [asset] };
}
