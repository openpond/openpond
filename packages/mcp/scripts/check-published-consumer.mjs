import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const consumer = await mkdtemp(path.join(tmpdir(), "openpond-mcp-consumer-"));
try {
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  for (const [name, range] of Object.entries(manifest.dependencies)) {
    if (/^(?:workspace|file|link):/.test(range)) {
      throw new Error(`Published dependency ${name} uses non-registry range ${range}.`);
    }
  }
  const dependencies = [];
  const expectedVersions = new Map();
  const packages = process.argv.includes("--local-dependencies")
    ? ["../harness", "../evals", "../sdk", "."]
    : ["."];
  for (const directory of packages) {
    const [packed] = JSON.parse(
      execFileSync(
        "npm",
        [
          "pack",
          path.resolve(root, directory),
          "--json",
          "--ignore-scripts",
          "--pack-destination",
          consumer,
        ],
        { encoding: "utf8" },
      ),
    );
    dependencies.push(path.join(consumer, packed.filename));
    expectedVersions.set(packed.name, packed.version);
  }
  await writeFile(
    path.join(consumer, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...dependencies], {
    cwd: consumer,
    stdio: "inherit",
  });
  const installed = JSON.parse(
    execFileSync("npm", ["ls", "--json", "--depth=0"], { cwd: consumer, encoding: "utf8" }),
  );
  for (const [name, version] of expectedVersions) {
    if (installed.dependencies?.[name]?.version !== version) {
      throw new Error(`Installed ${name} does not match packed version ${version}.`);
    }
    console.log(`Installed ${name}@${version}.`);
  }
  // Reuse the existing real MCP-client integration proof against the installed
  // tarball, so workspace links cannot conceal absent exports or dependencies.
  const proof = await readFile(path.join(root, "test/protocol-boundary.test.mjs"), "utf8");
  await writeFile(
    path.join(consumer, "protocol-boundary.test.mjs"),
    proof.replace('"../dist/index.js"', '"@openpond/mcp"'),
  );
  execFileSync(process.execPath, ["--test", "protocol-boundary.test.mjs"], {
    cwd: consumer,
    stdio: "inherit",
  });
  console.log(
    `Verified ${manifest.name}@${manifest.version} in an isolated installed consumer (${packages.length === 1 ? "registry dependencies" : "local dependency cohort"}).`,
  );
} finally {
  await rm(consumer, { recursive: true, force: true });
}
