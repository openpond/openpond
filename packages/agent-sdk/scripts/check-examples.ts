#!/usr/bin/env bun
import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

const root = import.meta.dir.replace(/\/scripts$/, "");

const examples = [
  {
    name: "blank-agent",
    cwd: "examples/blank-agent",
    runInput: {
      prompt: "Please answer this example request.",
      channel: "openpond_chat",
    },
  },
  {
    name: "customer-reply-agent",
    cwd: "examples/customer-reply-agent",
    runInput: {
      prompt: "Draft a reply to a customer asking for a scheduling update.",
      channel: "openpond_chat",
    },
  },
  {
    name: "water-estimator-agent",
    cwd: "examples/water-estimator-agent",
    runInput: {
      prompt: "Can you help with this project?",
      channel: "openpond_chat",
    },
  },
  {
    name: "integration-heavy-agent",
    cwd: "examples/integration-heavy-agent",
    runInput: {
      prompt: "Summarize this blocked project update.",
      channel: "openpond_chat",
    },
  },
  {
    name: "cross-system-operations",
    cwd: "examples/cross-system-operations",
    runInput: {
      prompt: "Which synthetic accounts need operational review?",
      channel: "openpond_chat",
    },
  },
] as const;

const commandMatrix = [
  ["inspect", "--json"],
  ["build", "--json"],
  ["validate", "--json"],
  ["eval", "--json"],
] as const;

for (const example of examples) {
  console.log(`Checking ${example.name}`);
  await rm(path.join(root, example.cwd, ".openpond"), { force: true, recursive: true });
  await runSdk(["inspect", "--json", "--cwd", example.cwd]);
  await runSdk(["build", "--json", "--cwd", example.cwd]);
  const firstBuildSnapshot = await readArtifactSnapshot(path.join(root, example.cwd, ".openpond"));
  await runSdk(["build", "--json", "--cwd", example.cwd]);
  const secondBuildSnapshot = await readArtifactSnapshot(path.join(root, example.cwd, ".openpond"));
  assertSnapshotsEqual(example.name, firstBuildSnapshot, secondBuildSnapshot);
  for (const command of commandMatrix) {
    await runSdk([...command, "--cwd", example.cwd]);
  }
  await runSdk([
    "run",
    "chat",
    "--cwd",
    example.cwd,
    "--input",
    JSON.stringify(example.runInput),
  ]);
  await runSdk(["traces", "--json", "--cwd", example.cwd]);
}

type ArtifactSnapshot = Map<string, string>;

async function readArtifactSnapshot(dir: string): Promise<ArtifactSnapshot> {
  const files = await listFiles(dir);
  const snapshot: ArtifactSnapshot = new Map();
  for (const file of files) {
    snapshot.set(file, await readFile(path.join(dir, file), "utf8"));
  }
  return snapshot;
}

async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(path.join(dir, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = path.join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(dir, relativePath)));
      continue;
    }
    if (entry.isFile()) files.push(relativePath);
  }
  return files.sort();
}

function assertSnapshotsEqual(exampleName: string, first: ArtifactSnapshot, second: ArtifactSnapshot) {
  const firstPaths = [...first.keys()].sort();
  const secondPaths = [...second.keys()].sort();
  if (JSON.stringify(firstPaths) !== JSON.stringify(secondPaths)) {
    throw new Error(
      `${exampleName} build artifacts are not deterministic: paths changed from ${firstPaths.join(", ")} to ${secondPaths.join(", ")}`,
    );
  }
  for (const artifactPath of firstPaths) {
    if (first.get(artifactPath) !== second.get(artifactPath)) {
      throw new Error(`${exampleName} build artifact changed on repeated build: ${artifactPath}`);
    }
  }
}

async function runSdk(args: string[]) {
  const proc = Bun.spawn(["bun", "./dist/cli.js", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode === 0) return;
  throw new Error(
    [
      `openpond-agent ${args.join(" ")} failed with exit code ${exitCode}`,
      stdout.trim(),
      stderr.trim(),
    ]
      .filter(Boolean)
      .join("\n"),
  );
}
