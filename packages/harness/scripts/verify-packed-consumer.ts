import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(path.join(os.tmpdir(), "openpond-harness-consumer-"));

try {
  const packed = JSON.parse(execFileSync(
    "npm",
    ["pack", root, "--json", "--pack-destination", temporary],
    { cwd: temporary, encoding: "utf8" },
  )) as Array<{ filename: string; integrity: string }>;
  const tarball = packed[0];
  if (!tarball?.filename || !tarball.integrity) {
    throw new Error("npm pack did not return tarball integrity metadata.");
  }
  await writeFile(
    path.join(temporary, "package.json"),
    `${JSON.stringify({
      name: "openpond-harness-clean-consumer",
      private: true,
      type: "module",
    }, null, 2)}\n`,
  );
  execFileSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      path.join(temporary, tarball.filename),
    ],
    { cwd: temporary, stdio: "inherit" },
  );
  await writeFile(path.join(temporary, "verify.mjs"), `
import {
  HostedHarnessRefinerRequestSchema,
  LocalHarnessRefinerDecisionV2Schema,
  HarnessRunOverlaySchema,
  ImprovementObservationSchema,
  ToolDeclarationSchema,
  createHarnessSourcePackage,
  validateHarnessSourcePackage,
  harnessSourcePackageFiles,
  resolveHarnessSourceSelection,
  createHarnessSourceRuntime,
  contentHash,
  admitLocalHarnessRefinerDecision,
} from "@openpond/harness";
import {
  HarnessCrossRunRefinementRequestSchema,
  HarnessRefinementCandidateSchema,
  HarnessRefinerActivityReceiptSchema,
} from "@openpond/harness/refinement-lifecycle";
import { ChatModelRefSchema, ProviderIdSchema } from "@openpond/harness/models";
import { harnessRuntimeModuleSource, harnessRuntimeModuleSha256 } from "@openpond/harness/runtime-source";
import { createHash } from "node:crypto";
if (createHash("sha256").update(harnessRuntimeModuleSource).digest("hex") !== harnessRuntimeModuleSha256) {
  throw new Error("packed standalone runtime hash mismatch");
}
// A data URL cannot resolve node_modules: this proves the distributed runtime is self-contained.
const standalone = await import("data:text/javascript;base64," + Buffer.from(harnessRuntimeModuleSource).toString("base64"));
const executed = await standalone.executeHarnessRollout({
  turnId: "packed-consumer", maxTurns: 1, signal: new AbortController().signal,
  runtime: null, systemPrompt: "Complete the task.", userPrompt: "Return done.", tools: [],
  policyRequest: async () => ({ result: { requestId: "packed-request" }, content: "done", toolCalls: [] }),
  step: async request => ({ toolResults: [], userMessage: null, terminal: request.content === "done" }),
  terminate: async () => { throw new Error("standalone runtime did not complete"); },
});
if (executed.policyResults.length !== 1 || !executed.finalStep.terminal || typeof standalone.createHarnessSourceRuntime !== "function") {
  throw new Error("packed standalone runtime execution failed");
}
if (ChatModelRefSchema.parse({ providerId: "openai", modelId: "example" }).modelId !== "example" || ProviderIdSchema.safeParse("unknown-provider").success) {
  throw new Error("packed chat model identity contract changed");
}
if (
  !HarnessRunOverlaySchema ||
  !HostedHarnessRefinerRequestSchema ||
  !LocalHarnessRefinerDecisionV2Schema ||
  !ImprovementObservationSchema ||
  !ToolDeclarationSchema ||
  !HarnessCrossRunRefinementRequestSchema ||
  !HarnessRefinementCandidateSchema ||
  !HarnessRefinerActivityReceiptSchema ||
  typeof admitLocalHarnessRefinerDecision !== "function" ||
  typeof createHarnessSourcePackage !== "function" ||
  typeof validateHarnessSourcePackage !== "function" ||
  typeof harnessSourcePackageFiles !== "function" ||
  typeof resolveHarnessSourceSelection !== "function" ||
  typeof createHarnessSourceRuntime !== "function"
) {
  throw new Error("packed Harness exports unavailable");
}
if (!/^[a-f0-9]{64}$/.test(contentHash({ harness: true }))) {
  throw new Error("packed Harness hashing failed");
}
process.stdout.write("clean Harness consumer verified\\n");
`);
  await writeFile(path.join(temporary, "verify-types.mts"), `
import type {
  AgentSnapshot,
  HarnessRefinerEvidenceBasis,
  HarnessRelease,
  HarnessSourcePackage,
  HarnessSourceSelection,
  HarnessRunOverlay,
  ImprovementObservation,
  LocalHarnessRefinerDecisionV2,
  ToolDeclaration,
} from "@openpond/harness";
import type {
  HarnessCrossRunRefinementRequest,
  HarnessRefinementCandidate,
  HarnessRefinerActivityReceipt,
} from "@openpond/harness/refinement-lifecycle";
import type { ChatModelRef, ProviderId } from "@openpond/harness/models";
import { harnessRuntimeModuleSource, harnessRuntimeModuleSha256 } from "@openpond/harness/runtime-source";
const runtimeDistribution: string[] = [harnessRuntimeModuleSource, harnessRuntimeModuleSha256];
void runtimeDistribution;
const chatModel: ChatModelRef = { providerId: "openai" satisfies ProviderId, modelId: "example" };
void chatModel;
void (null as unknown as
  | AgentSnapshot
  | HarnessRefinerEvidenceBasis
  | HarnessRelease
  | HarnessSourcePackage
  | HarnessSourceSelection
  | HarnessRunOverlay
  | ImprovementObservation
  | LocalHarnessRefinerDecisionV2
  | ToolDeclaration
  | HarnessCrossRunRefinementRequest
  | HarnessRefinementCandidate
  | HarnessRefinerActivityReceipt
);
`);
  execFileSync(process.execPath, [path.join(temporary, "verify.mjs")], {
    cwd: temporary,
    stdio: "inherit",
  });
  execFileSync(path.resolve(root, "../../node_modules/.bin/tsc"), [
    "--noEmit",
    "--strict",
    "--skipLibCheck",
    "--target",
    "ES2022",
    "--module",
    "NodeNext",
    "--moduleResolution",
    "NodeNext",
    path.join(temporary, "verify-types.mts"),
  ], { cwd: temporary, stdio: "inherit" });
  const manifest = JSON.parse(await readFile(
    path.join(temporary, "node_modules/@openpond/harness/package.json"),
    "utf8",
  )) as { version?: string };
  console.log(
    `Verified packed @openpond/harness@${manifest.version ?? "unknown"} with integrity ${tarball.integrity}.`,
  );
} finally {
  await rm(temporary, { force: true, recursive: true });
}
