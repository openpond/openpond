import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(path.join(os.tmpdir(), "openpond-evals-consumer-"));

try {
  const packed = JSON.parse(execFileSync("npm", ["pack", root, "--json", "--pack-destination", temporary], {
    cwd: temporary,
    encoding: "utf8",
  })) as Array<{ filename: string; integrity: string }>;
  const tarball = packed[0];
  if (!tarball?.filename || !tarball.integrity) throw new Error("npm pack did not return tarball integrity metadata.");
  await writeFile(path.join(temporary, "package.json"), `${JSON.stringify({ name: "openpond-evals-clean-consumer", private: true, type: "module" }, null, 2)}\n`);
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", path.join(temporary, tarball.filename)], {
    cwd: temporary,
    stdio: "inherit",
  });
  await writeFile(path.join(temporary, "verify.mjs"), `
import { verifyAttemptReceipt } from "@openpond/evals";
import { genericToolConformance } from "@openpond/evals/conformance";
import { validateTasksetRelease } from "@openpond/evals/tasksets";
import { RunManifestSchema } from "@openpond/evals/runs";
import { HarnessReleaseSchema } from "@openpond/evals/harness";
import { gradeEvidence } from "@openpond/evals/graders";
import { verifyWorkEvidenceReceipt, workEvidenceConformance } from "@openpond/evals/evidence";

const fixture = genericToolConformance;
if (!validateTasksetRelease(fixture.taskset).valid) throw new Error("packed Taskset validation failed");
HarnessReleaseSchema.parse(fixture.harness);
RunManifestSchema.parse(fixture.manifest);
const grades = await gradeEvidence({
  task: fixture.taskset.tasks[0],
  evidence: { output: { text: "done" }, runtimeEventRefs: [], artifactRefs: [] },
  graders: fixture.taskset.graders,
});
if (!grades[0]?.passed) throw new Error("packed deterministic grader failed");
if (verifyAttemptReceipt({}) !== false) throw new Error("invalid receipt was accepted");
if (!verifyWorkEvidenceReceipt(workEvidenceConformance.receipt)) throw new Error("packed Work evidence validation failed");
process.stdout.write("clean consumer verified\\n");
`);
  await writeFile(path.join(temporary, "verify-types.mts"), `
import type { AttemptReceipt, HarnessExecutor, TasksetRelease } from "@openpond/evals";
import type { HarnessRuntime } from "@openpond/evals/harness";
import type { GraderEvidence } from "@openpond/evals/graders";
import type { RunManifest } from "@openpond/evals/runs";
import type { TaskRecord } from "@openpond/evals/tasksets";
import type { WorkEvidenceReceipt, WorkFeedbackReceipt, WorkProcessTrace } from "@openpond/evals/evidence";
void (null as unknown as AttemptReceipt | HarnessExecutor | TasksetRelease | HarnessRuntime | GraderEvidence | RunManifest | TaskRecord | WorkEvidenceReceipt | WorkFeedbackReceipt | WorkProcessTrace);
`);
  execFileSync(process.execPath, [path.join(temporary, "verify.mjs")], { cwd: temporary, stdio: "inherit" });
  execFileSync(path.resolve(root, "../../node_modules/.bin/tsc"), [
    "--noEmit", "--strict", "--skipLibCheck", "--target", "ES2022",
    "--module", "NodeNext", "--moduleResolution", "NodeNext",
    path.join(temporary, "verify-types.mts"),
  ], { cwd: temporary, stdio: "inherit" });
  const manifest = JSON.parse(await readFile(path.join(temporary, "node_modules/@openpond/evals/package.json"), "utf8")) as { version?: string };
  console.log(`Verified packed @openpond/evals@${manifest.version ?? "unknown"} with integrity ${tarball.integrity}.`);
} finally {
  await rm(temporary, { force: true, recursive: true });
}
