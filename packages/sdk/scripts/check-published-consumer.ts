import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    const dependencies = [tarball];
    if (process.argv.includes("--local-evals")) {
      // Test the actual release artifacts before the new Evals version reaches npm.
      const packedEvals = JSON.parse(execFileSync("npm", ["pack", path.resolve(packageRoot, "../evals"), "--json", "--ignore-scripts", "--pack-destination", consumer], { encoding: "utf8" })) as PackResult;
      if (!packedEvals[0]?.filename) throw new Error("npm pack did not produce an Evals tarball.");
      dependencies.push(path.join(consumer, packedEvals[0].filename));
    }
    execFileSync("npm", ["init", "--yes"], {
      cwd: consumer,
      stdio: "ignore",
    });
    execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...dependencies], {
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
          'import { OpenPondTasksetCatalogClient, HostedTasksetSummarySchema } from "openpond-sdk/taskset-catalog";',
          'import { TrainingJobSubmissionSchema } from "openpond-sdk/training";',
          'import { OpenPondLearningClient, OpenPondLearningError, LearningSourceSchema, TaskExampleSubmissionSchema, TaskEvidenceSchema, sealLearningContent, createSourceCredentialRequest, LearningSourceCredentialRequestSchema, LearningSourceConfigurationSchema } from "openpond-sdk/learning";',
          'if (!ModelProjectSchema || !TrainingJobSubmissionSchema) process.exit(1);',
          'const prepared = createSourceCredentialRequest({ sourceId: "source", name: "Packed consumer", expiresAt: new Date(Date.now() + 86400000).toISOString() }); LearningSourceCredentialRequestSchema.parse({ ...prepared, action: "create", scope: "team" }); if (!LearningSourceConfigurationSchema || typeof OpenPondLearningClient.prototype.sourceConfiguration !== "function") throw new Error("Packed source credential exports are missing");',
          'if (!OpenPondTasksetCatalogClient || !HostedTasksetSummarySchema) throw new Error("Packed Taskset catalog exports are missing");',
          'const source = LearningSourceSchema.parse(sealLearningContent({ schemaVersion: "openpond.learningSource.v1", id: "source", revision: 1, name: "Consumer source", kind: "direct", taskDefinition: { id: "definition", revision: 1, contentHash: "a".repeat(64) }, enabled: true, allowedSplits: ["train"], mapping: null, adapterVersion: null }));',
          'const example = TaskExampleSubmissionSchema.parse({ schemaVersion: "openpond.taskExample.v1", sourceId: source.id, taskDefinition: source.taskDefinition, idempotencyKey: "consumer-example", exampleId: "example", attemptId: "attempt", occurredAt: "2026-09-06T12:00:00.000Z", familyKey: "family", split: "train", input: { question: "Two plus two?" }, observedOutput: { answer: "5" }, expected: { answer: "4" }, evaluatorContext: null, assets: [], provenance: { sourceRecordRef: null, mappingHash: null } });',
          'let calls = 0; const client = new OpenPondLearningClient({ apiKey: "consumer-test-token", baseUrl: "https://consumer.invalid", scope: "team", fetch: async (url, init) => { calls++; if (init.headers.Authorization !== "Bearer consumer-test-token" || init.redirect !== "error") throw new Error("Credential/redirect boundary failed"); const body = JSON.parse(init.body); if (body.scope !== "team" || init.headers["X-OpenPond-Team-Id"] !== "team") throw new Error("Scope mismatch"); if (String(url).endsWith("/read")) return Response.json(source); if (body.command.example.idempotencyKey !== "consumer-example") throw new Error("Producer identity mismatch"); const evidence = TaskEvidenceSchema.parse(sealLearningContent({ schemaVersion: "openpond.taskEvidence.v1", id: "evidence", revision: 1, source: { id: source.id, revision: source.revision, contentHash: source.contentHash }, submission: example, supersedes: null, correctionFeedbackId: null, receivedAt: example.occurredAt })); return Response.json({ operationId: body.command.operationId, resources: [evidence] }); } });',
          'await client.get("source", source.id); const receipt = await client.submitExample(example); if (receipt.resources[0].submission.observedOutput.answer !== "5" || calls !== 2) throw new Error("Packed SDK transport failed");',
          'const rejected = new OpenPondLearningClient({ apiKey: "test", baseUrl: "https://consumer.invalid", scope: "team", fetch: async () => Response.json({ code: "conflict", error: "Revision conflict" }, { status: 409 }) }); try { await rejected.get("source", "source"); throw new Error("Expected 409"); } catch (error) { if (!(error instanceof OpenPondLearningError) || error.status !== 409 || error.code !== "conflict") throw error; }',
        ].join("\n"),
      ],
      { cwd: consumer, stdio: "inherit" },
    );
    await writeFile(path.join(consumer, "verify-types.mts"), 'import { OpenPondLearningClient, type TaskExampleSubmission, type LearningCommand } from "openpond-sdk/learning";\ndeclare const client: OpenPondLearningClient;\ndeclare const example: TaskExampleSubmission;\nconst command: LearningCommand = { action: "submit_example", operationId: example.idempotencyKey, example };\nvoid client.command(command);\n');
    execFileSync(path.resolve(packageRoot, "../../node_modules/.bin/tsc"), ["--noEmit", "--strict", "--skipLibCheck", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", path.join(consumer, "verify-types.mts")], { cwd: consumer, stdio: "inherit" });
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
