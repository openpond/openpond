import { execFile } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);

const criticalFiles = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "vitest.config.ts",
  "scripts/ci-change-scope.mjs",
  "scripts/run-affected-tests.ts",
  "scripts/run-tests.ts",
  "scripts/test-suite-config.ts",
]);

export function classifyCiChanges(rawFiles, eventName = "pull_request", deletedFiles = []) {
  const files = [...new Set(rawFiles.map((file) => file.replace(/^\.\//, "")).filter(Boolean))].sort();
  const domains = new Set();
  for (const file of files) {
    const match = file.match(/^(apps|packages|python)\/([^/]+)/);
    if (match) domains.add(`${match[1]}/${match[2]}`);
  }

  const docsOnly = files.length > 0 && files.every(isDocumentationFile);
  const reasons = [];
  if (eventName !== "pull_request") reasons.push(`${eventName} runs protect master and manual releases`);
  if (files.length === 0) reasons.push("no changed files were detected safely");
  if (files.length > 50) reasons.push(`${files.length} files exceed the broad-change limit`);
  if (files.some((file) => criticalFiles.has(file))) reasons.push("test or workspace infrastructure changed");
  if (files.some((file) => file.startsWith("packages/contracts/src/"))) reasons.push("shared runtime contracts changed");
  if (deletedFiles.some(isProductionCodeFile)) reasons.push("production code was deleted");
  if (domains.size >= 3) reasons.push(`${domains.size} app/package domains changed`);

  const full = reasons.length > 0;
  const workflow = files.some((file) => file.startsWith(".github/workflows/") || file === "scripts/check-workflows.ts" || file === "scripts/run-actionlint.ts");
  const release = files.some((file) => file === "apps/desktop/package.json" || file.startsWith("scripts/release-") || file.startsWith(".github/workflows/release-"));
  const python = files.some((file) => file.startsWith("python/") && /(?:\.py|\.toml|\.lock)$/.test(file));
  const affectedTests = files.some((file) => /(?:^|\/)[^/]+\.(?:[cm]?[jt]sx?)$/.test(file));
  const nodeContracts = files.some((file) => file.endsWith(".test.mjs"));
  const image = files.some((file) => file.includes("local-image-tool-registry") || file === "tests/local-image-tool-registry.test.ts");

  return {
    affectedTests,
    agentSdk: files.some((file) => file.startsWith("packages/agent-sdk/")),
    cli: files.some((file) => file.startsWith("apps/cli/")),
    docsOnly,
    files,
    full,
    image,
    install: !docsOnly,
    nodeContracts,
    python,
    reason: full ? reasons.join("; ") : docsOnly ? "documentation-only change" : "bounded pull-request change",
    release,
    repositoryChecks: !docsOnly,
    typecheck: files.some((file) => /(?:^|\/)(?:package\.json|tsconfig(?:\.[^/]+)?\.json)$/.test(file) || /\.(?:ts|tsx|mts|cts)$/.test(file)),
    workflow,
  };
}

function isDocumentationFile(file) {
  return file.startsWith("docs/") || file === "README.md" || file.endsWith(".md");
}

function isProductionCodeFile(file) {
  return /^(?:apps|packages)\/.+\.(?:[cm]?[jt]sx?)$/.test(file);
}

async function changedFiles(base, head) {
  const { stdout } = await execFileAsync("git", ["diff", "--name-only", "--diff-filter=ACMRD", base, head], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.split(/\r?\n/).filter(Boolean);
}

async function deletedFiles(base, head) {
  const { stdout } = await execFileAsync("git", ["diff", "--name-only", "--diff-filter=D", base, head], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.split(/\r?\n/).filter(Boolean);
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`invalid argument list near ${key ?? "end"}`);
    values.set(key.slice(2), value);
  }
  return values;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const eventName = args.get("event") ?? process.env.GITHUB_EVENT_NAME ?? "pull_request";
  const base = args.get("base") ?? process.env.CI_BASE_SHA;
  const head = args.get("head") ?? process.env.CI_HEAD_SHA ?? "HEAD";
  if (!base) throw new Error("CI change scoping requires --base or CI_BASE_SHA");

  const files = eventName === "pull_request" ? await changedFiles(base, head) : [];
  const deleted = eventName === "pull_request" ? await deletedFiles(base, head) : [];
  const result = classifyCiChanges(files, eventName, deleted);
  console.log(`[ci-scope] ${result.full ? "full" : "targeted"}: ${result.reason}`);
  console.log(`[ci-scope] ${result.files.length} changed file(s)`);

  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  const fields = {
    affected_tests: result.affectedTests,
    agent_sdk: result.agentSdk,
    base,
    cli: result.cli,
    full: result.full,
    head,
    image: result.image,
    install: result.install,
    node_contracts: result.nodeContracts,
    python: result.python,
    reason: result.reason,
    release: result.release,
    repository_checks: result.repositoryChecks,
    typecheck: result.typecheck,
    workflow: result.workflow,
  };
  await appendFile(output, Object.entries(fields).map(([key, value]) => `${key}=${String(value).replace(/[\r\n]+/g, " ")}\n`).join(""));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
