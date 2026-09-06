import { readFile } from "node:fs/promises";
import { OpenPondLearningClient, TaskExampleSubmissionSchema, TaskEvidenceSchema } from "openpond-sdk/learning";

// node --experimental-strip-types submit.ts SOURCE_ID example.json
// Set OPENPOND_API_KEY, OPENPOND_API_URL and OPENPOND_LEARNING_SCOPE in your shell.
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} before running this example.`);
  return value;
}
const [sourceId, file] = process.argv.slice(2);
if (!sourceId || !file) throw new Error("Usage: submit.ts SOURCE_ID example.json");
const client = new OpenPondLearningClient({ apiKey: required("OPENPOND_API_KEY"), baseUrl: required("OPENPOND_API_URL"), scope: required("OPENPOND_LEARNING_SCOPE") });
const source = await client.sourceConfiguration(sourceId);
const record: unknown = JSON.parse(await readFile(file, "utf8"));
if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("Expected one JSON object.");
const example = TaskExampleSubmissionSchema.parse({ ...record, schemaVersion: "openpond.taskExample.v1", sourceId, taskDefinition: source.taskDefinition });
const receipt = await client.submitExample(example);
const evidence = TaskEvidenceSchema.parse(receipt.resources[0]);
console.log(JSON.stringify({ operationId: receipt.operationId, evidenceId: evidence.id, revision: evidence.revision, contentHash: evidence.contentHash }));
