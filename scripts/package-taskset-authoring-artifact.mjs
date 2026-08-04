import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ARTIFACT_VERSION = "openpond.taskset-authoring.2026-08-03.1";
const SOURCE_COMMIT = "193e5e4d6c3a6b9b80af9becec0f0ebaaee875e9";
const SKILL_NAME = "openpond-taskset-authoring";
const FILES = [
  "SKILL.md",
  "references/task-design.md",
  "references/graders-and-rewards.md",
  "references/method-selection.md",
  "references/privacy-and-provenance.md",
];

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const skillRoot = path.join(
  repositoryRoot,
  "apps",
  "cli",
  "skills",
  SKILL_NAME,
);
const artifactPath = path.join(skillRoot, "artifact.json");

const files = await Promise.all(
  FILES.map(async (relativePath) => {
    const contents = await readFile(path.join(skillRoot, relativePath), "utf8");
    return {
      path: relativePath,
      sha256: sha256(contents),
      contents,
    };
  }),
);
const skill = files[0]?.contents.trim();
if (!skill) throw new Error("Taskset Authoring SKILL.md is empty.");
const bundle = [
  skill,
  ...files.slice(1).map(
    (file) =>
      `\n## Bundled reference: ${path.basename(file.path)}\n\n${file.contents.trim()}`,
  ),
].join("\n");
const core = {
  schemaVersion: 1,
  artifactVersion: ARTIFACT_VERSION,
  skillName: SKILL_NAME,
  source: {
    repository: "openpond/openpond",
    commit: SOURCE_COMMIT,
    path: `apps/cli/skills/${SKILL_NAME}`,
  },
  files,
  bundle,
};
const artifact = {
  ...core,
  contentHash: sha256(JSON.stringify(core)),
};
const serialized = `${JSON.stringify(artifact, null, 2)}\n`;

if (process.argv.includes("--check")) {
  const current = await readFile(artifactPath, "utf8").catch(() => "");
  if (current !== serialized) {
    throw new Error(
      "Taskset Authoring artifact is stale. Run pnpm run skills:package-taskset-authoring.",
    );
  }
  console.log(
    `PASS: ${artifact.artifactVersion} sha256:${artifact.contentHash}`,
  );
} else {
  await writeFile(artifactPath, serialized, "utf8");
  console.log(
    `WROTE: ${artifactPath} sha256:${artifact.contentHash}`,
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
