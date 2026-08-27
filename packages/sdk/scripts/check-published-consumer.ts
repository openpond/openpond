import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

type PackageManifest = {
  dependencies?: Record<string, string>;
};

type PackResult = Array<{
  filename: string;
}>;

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function main(): Promise<void> {
  const manifest = JSON.parse(
    await readFile(path.join(packageRoot, "package.json"), "utf8"),
  ) as PackageManifest;
  for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
    if (/^(?:workspace|file|link):/.test(range)) {
      throw new Error(
        `Published runtime dependency ${name} uses non-registry range ${range}.`,
      );
    }
  }

  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--ignore-scripts"], {
      cwd: packageRoot,
      encoding: "utf8",
    }),
  ) as PackResult;
  const filename = packed[0]?.filename;
  if (!filename) throw new Error("npm pack did not produce an SDK tarball.");

  const tarball = path.join(packageRoot, filename);
  const consumer = await mkdtemp(path.join(tmpdir(), "openpond-sdk-consumer-"));
  try {
    execFileSync("npm", ["init", "--yes"], {
      cwd: consumer,
      stdio: "ignore",
    });
    execFileSync("npm", ["install", "--ignore-scripts", tarball], {
      cwd: consumer,
      stdio: "inherit",
    });
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        [
          'import { ModelProjectSchema } from "openpond-sdk/model-projects";',
          'import { TrainingJobSubmissionSchema } from "openpond-sdk/training";',
          'if (!ModelProjectSchema || !TrainingJobSubmissionSchema) process.exit(1);',
        ].join("\n"),
      ],
      { cwd: consumer, stdio: "inherit" },
    );
  } finally {
    await Promise.all([
      rm(tarball, { force: true }),
      rm(consumer, { recursive: true, force: true }),
    ]);
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
