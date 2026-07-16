#!/usr/bin/env node
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const maxLines = 1_000;
const requiredReadmePhrases = [
  "openpond-agent init",
  "Public Exports",
  "Generated Artifacts",
  "Feature Matrix",
  "Platform Boundary",
  "Validation",
  "Negative Validation Examples",
  "CLI Machine Output",
  "Tracing",
  "Evals",
  "Templates",
];
const requiredTemplates = ["blank-agent", "customer-reply-agent", "integration-heavy-agent"];
const requiredDocs = {
  "docs/api.md": ["Public API", "openpond-agent-sdk/primitives", "openpond-agent-sdk/runtime"],
  "docs/authoring.md": ["Authoring Guide", "agent/agent.ts", "editable(...)"],
  "docs/cli.md": ["CLI Reference", "openpond-agent inspect", "openpond-agent build"],
  "docs/artifacts.md": ["Generated Artifacts", "artifact-index.json", "openpond.agent.trace.v1"],
  "docs/validation.md": ["Validation", "typescript_manifest_openpond_yaml_drift", "eval_expected_artifact_not_declared"],
  "docs/tracing-evals.md": ["Tracing And Evals", "ctx.step", "expectedArtifacts"],
  "docs/templates.md": ["Templates And Examples", "integration-heavy-agent", "scripts/check-package-install.ts"],
  "docs/migration.md": ["Migration Notes", "extends-openpond-yaml", "Python and Rust"],
  "docs/feature-matrix.md": ["SDK Feature Matrix", "defineAgentProject", "openpond-agent inspect --json", "Platform consumer"],
  "docs/platform-boundary.md": ["Platform Boundary", "Integration lease selection", "draft source refs"],
  "docs/cli-machine-output.md": ["CLI Machine Output", "Exit-Code Policy", "openpond-agent eval --json"],
  "docs/negative-validation-examples.md": ["Negative Validation Examples", "examples/validation-failures", "Failed eval gate"],
  "docs/package-audit.md": ["Package Audit", "pnpm check", "packed-install check", "Current Verdict"],
};
const requiredTestSuites = [
  "test/primitive-contract.test.ts",
  "test/source-loader-contract.test.ts",
  "test/channel-harness-contract.test.ts",
  "test/runtime-harness-contract.test.ts",
  "test/artifact-index-contract.test.ts",
  "test/validation-issues-contract.test.ts",
  "test/pilot-examples-contract.test.ts",
  "test/openpond-code-inspect-contract.test.ts",
  "test/negative-validation-examples-contract.test.ts",
];
const ignoredDirs = new Set(["node_modules", "dist", ".openpond-test-fixtures", ".git"]);

await checkReadme();
await checkDocs();
await checkTemplates();
await checkPilotScenarios();
await checkExampleDocs();
await checkExampleArtifacts();
await checkNegativeExamples();
await checkNoHandAuthoredActionWrappers();
await checkTestSuites();
await checkLineCounts();
await checkPackageExports();
await checkPublicImports();
await checkRootPackageIdentity();
await checkNoRealSecrets();

console.log("Package hygiene check passed.");

async function checkReadme() {
  const readme = await readFile(path.join(root, "README.md"), "utf8");
  const missing = requiredReadmePhrases.filter((phrase) => !readme.includes(phrase));
  if (missing.length > 0) {
    throw new Error(`README is missing required coverage: ${missing.join(", ")}`);
  }
}

async function checkTemplates() {
  for (const template of requiredTemplates) {
    await mustExist(path.join(root, "templates", template, "package.json"));
    await mustExist(path.join(root, "templates", template, "agent", "agent.ts"));
    await mustExist(path.join(root, "templates", template, "agent", "instructions.md"));
  }
}

async function checkDocs() {
  for (const [doc, phrases] of Object.entries(requiredDocs)) {
    const text = await readFile(path.join(root, doc), "utf8");
    const missing = phrases.filter((phrase) => !text.includes(phrase));
    if (missing.length > 0) {
      throw new Error(`${doc} is missing required coverage: ${missing.join(", ")}`);
    }
  }
}

async function checkPilotScenarios() {
  const text = await readFile(path.join(root, "examples", "PILOT-SCENARIOS.md"), "utf8");
  const requiredPhrases = [
    "Blank Agent",
    "Customer Reply Agent",
    "Water Estimator Agent",
    "Integration Heavy Agent",
    "Source tree",
    "Generated artifact tree",
    "Setup slots and inspect/deploy-plan projection",
    "Safe Builder Chat edit scenario",
    "Channel Coverage Matrix",
    "Volume And Setup Matrix",
    "Migration Paths",
    "manifestMode: \"extends-openpond-yaml\"",
    "drawing-plans",
    "water-history",
    "project-state",
    "OPENAI_API_KEY",
    "Microsoft Teams",
    "MCP",
    "Manual action",
  ];
  const missing = requiredPhrases.filter((phrase) => !text.includes(phrase));
  if (missing.length > 0) {
    throw new Error(`examples/PILOT-SCENARIOS.md is missing required coverage: ${missing.join(", ")}`);
  }
}

async function checkExampleArtifacts() {
  for (const example of ["blank-agent", "customer-reply-agent", "water-estimator-agent", "integration-heavy-agent"]) {
    const base = path.join(root, "examples", example, ".openpond");
    await mustExist(path.join(base, "agent-manifest.json"));
    await mustExist(path.join(base, "action-registry.json"));
    await mustExist(path.join(base, "agent-inspect.json"));
    await mustExist(path.join(base, "artifact-index.json"));
    await mustExist(path.join(base, "validator-report.md"));
  }
}

async function checkExampleDocs() {
  const requiredExamplePhrases: Record<string, string[]> = {
    "blank-agent": ["Setup Slots", "markdown instructions", "minimal happy path"],
    "customer-reply-agent": ["TypeScript-generated instructions", "optional Slack", "small template path"],
    "integration-heavy-agent": ["required and optional integrations", "select-or-create", "disabled by default"],
    "water-estimator-agent": ["CROSSWALK.md", "complex path", "Teams/Microsoft setup requirements"],
  };
  for (const [example, phrases] of Object.entries(requiredExamplePhrases)) {
    const readme = await readFile(path.join(root, "examples", example, "README.md"), "utf8");
    const missing = phrases.filter((phrase) => !readme.includes(phrase));
    if (missing.length > 0) {
      throw new Error(`examples/${example}/README.md is missing required coverage: ${missing.join(", ")}`);
    }
  }
  const crosswalk = await readFile(path.join(root, "examples", "water-estimator-agent", "CROSSWALK.md"), "utf8");
  const missingCrosswalk = [
    "Actions And Commands",
    "Workflows And Implementation Files",
    "Integrations And Channels",
    "Volumes And State",
    "Artifacts",
    "Fixtures And Tests",
  ].filter((phrase) => !crosswalk.includes(phrase));
  if (missingCrosswalk.length > 0) {
    throw new Error(`Water estimator crosswalk is missing: ${missingCrosswalk.join(", ")}`);
  }
}

async function checkNegativeExamples() {
  await mustExist(path.join(root, "examples", "validation-failures", "README.md"));
  await mustExist(path.join(root, "examples", "validation-failures", "agent", "agent.ts"));
  await mustExist(path.join(root, "examples", "validation-failures", "openpond.yaml"));
  await mustExist(path.join(root, "examples", "validation-failures", "eval-gate", "agent", "agent.ts"));
  const readme = await readFile(path.join(root, "examples", "validation-failures", "README.md"), "utf8");
  const missing = [
    "typescript_manifest_openpond_yaml_drift",
    "channel_missing_integration_requirement",
    "env_name_required",
    "volume_used_by_action_missing",
    "skill_generated_file_path_invalid",
    "eval_expected_artifact_not_declared",
    "fails-gate",
  ].filter((phrase) => !readme.includes(phrase));
  if (missing.length > 0) {
    throw new Error(`examples/validation-failures/README.md is missing required coverage: ${missing.join(", ")}`);
  }
}

async function checkNoHandAuthoredActionWrappers() {
  for (const example of ["blank-agent", "customer-reply-agent", "water-estimator-agent", "integration-heavy-agent"]) {
    const actionWrapperDir = path.join(root, "examples", example, "src", "actions");
    try {
      const entries = await readdir(actionWrapperDir);
      if (entries.length > 0) {
        throw new Error(`Example ${example} must not include hand-authored src/actions wrappers.`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("must not include")) throw error;
    }
  }
}

async function checkTestSuites() {
  for (const suite of requiredTestSuites) {
    await mustExist(path.join(root, suite));
  }
}

async function checkLineCounts() {
  const files = await listFiles(root);
  for (const file of files) {
    if (isGeneratedOutput(file)) continue;
    if (!/\.(ts|md|json)$/.test(file)) continue;
    const text = await readFile(path.join(root, file), "utf8");
    const lines = text.split("\n").length;
    if (lines > maxLines) {
      throw new Error(`${file} has ${lines} lines, above the ${maxLines} line limit.`);
    }
  }
}

function isGeneratedOutput(file: string) {
  return (
    file.includes("/.openpond/") ||
    file.includes("/.openpond-negative/") ||
    file.includes("/generated/")
  );
}

async function checkPackageExports() {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
    exports: Record<string, unknown>;
  };
  for (const exportName of Object.keys(packageJson.exports)) {
    if (exportName === "." || exportName === "./package.json" || exportName === "./cli") continue;
    const source = path.join(root, "src", exportName.replace(/^\.\//, ""), "index.ts");
    await mustExist(source);
  }
}

async function checkRootPackageIdentity() {
  const packageJsonText = await readFile(path.join(root, "package.json"), "utf8");
  const packageJson = JSON.parse(packageJsonText) as {
    name?: string;
    description?: string;
    keywords?: string[];
    scripts?: Record<string, string>;
  };
  const packageIdentityText = [
    packageJson.name ?? "",
    packageJson.description ?? "",
    ...(packageJson.keywords ?? []),
  ].join("\n");
  const exampleNames = [
    "blank-agent",
    "customer-reply-agent",
    "integration-heavy-agent",
    "water-estimator-agent",
  ];
  const identityOffenders = exampleNames.filter((example) => packageIdentityText.includes(example));
  if (identityOffenders.length > 0) {
    throw new Error(`Package metadata must not use an example as package identity: ${identityOffenders.join(", ")}`);
  }

  const scriptOffenders = Object.entries(packageJson.scripts ?? {})
    .filter(([name, script]) =>
      exampleNames.some((example) => name.includes(example) || script.includes(`examples/${example}`))
    )
    .map(([name]) => name);
  if (scriptOffenders.length > 0) {
    throw new Error(`Root scripts must stay package-first, not example-specific: ${scriptOffenders.join(", ")}`);
  }

  const readme = await readFile(path.join(root, "README.md"), "utf8");
  const intro = readme.split("\n").slice(0, 12).join("\n");
  const introOffenders = exampleNames.filter((example) => intro.includes(example));
  if (introOffenders.length > 0) {
    throw new Error(`README introduction must describe the SDK, not one example: ${introOffenders.join(", ")}`);
  }
}

async function checkPublicImports() {
  const files = await listFiles(root);
  const importPattern = /from\s+["'](?:\.\.\/){1,}src\/|from\s+["']openpond-agent-sdk\/(?:core|commands|cli)\b/;
  const offenders: string[] = [];
  for (const file of files) {
    if (!file.startsWith("examples/") && !file.startsWith("templates/") && !file.startsWith("test/")) continue;
    if (!file.endsWith(".ts")) continue;
    const text = await readFile(path.join(root, file), "utf8");
    if (importPattern.test(text)) offenders.push(file);
  }
  if (offenders.length > 0) {
    throw new Error(`Public fixtures import private SDK internals: ${offenders.join(", ")}`);
  }
}

async function checkNoRealSecrets() {
  const files = await listFiles(root);
  const secretPattern = /(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|-----BEGIN (?:RSA |OPENSSH |EC |)?PRIVATE KEY-----)/;
  const offenders: string[] = [];
  for (const file of files) {
    if (!/\.(ts|md|json|yaml|yml)$/.test(file)) continue;
    const text = await readFile(path.join(root, file), "utf8");
    if (secretPattern.test(text)) offenders.push(file);
  }
  if (offenders.length > 0) {
    throw new Error(`Files contain values matching real secret patterns: ${offenders.join(", ")}`);
  }
}

async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(dir);
  const files: string[] = [];
  for (const entry of entries) {
    if (ignoredDirs.has(entry)) continue;
    if (entry === ".env" || entry.startsWith(".env.")) continue;
    const fullPath = path.join(dir, entry);
    const relativePath = path.join(prefix, entry);
    const info = await stat(fullPath);
    if (info.isDirectory()) {
      files.push(...await listFiles(fullPath, relativePath));
    } else {
      files.push(relativePath);
    }
  }
  return files;
}

async function mustExist(filePath: string) {
  try {
    await stat(filePath);
  } catch {
    throw new Error(`Required file is missing: ${path.relative(root, filePath)}`);
  }
}
