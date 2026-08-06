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
  HarnessRunOverlaySchema,
  ImprovementObservationSchema,
  ToolDeclarationSchema,
  contentHash,
} from "@openpond/harness";
if (!HarnessRunOverlaySchema || !ImprovementObservationSchema || !ToolDeclarationSchema) {
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
  HarnessRelease,
  HarnessRunOverlay,
  ImprovementObservation,
  ToolDeclaration,
} from "@openpond/harness";
void (null as unknown as AgentSnapshot | HarnessRelease | HarnessRunOverlay | ImprovementObservation | ToolDeclaration);
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
