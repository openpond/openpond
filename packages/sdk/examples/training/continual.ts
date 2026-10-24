import { readFile, writeFile } from "node:fs/promises";
import { LearningCommandSchema, LearningRevisionRefSchema, OpenPondLearningClient } from "openpond-sdk/learning";

const [action, inputPath, outputPath] = process.argv.slice(2);
if (!["inspect", "command"].includes(action ?? "") || !inputPath || !outputPath) throw new Error("Usage: continual.ts <inspect|command> <policy-ref-or-command.json> <new-response.json>");
const { OPENPOND_API_URL: baseUrl, OPENPOND_API_KEY: apiKey, OPENPOND_TEAM_ID: scope } = process.env;
if (!baseUrl || !apiKey || !scope) throw new Error("Set OPENPOND_API_URL, OPENPOND_API_KEY and OPENPOND_TEAM_ID.");
const bytes = await readFile(inputPath);
if (bytes.byteLength > 16_777_216) throw new Error("Learning input exceeds the protocol limit.");
const input: unknown = JSON.parse(bytes.toString("utf8"));
const client = new OpenPondLearningClient({ baseUrl, apiKey, scope });
const options = { signal: AbortSignal.timeout(120_000) };
// The same typed command covers existing publish/review/seal/reserve/cancel
// operations. Preserve operationId and pinned releases on uncertain responses.
const result = action === "inspect"
  ? await client.inspectPolicy(LearningRevisionRefSchema.parse(input), options)
  : await client.command(LearningCommandSchema.parse(input), options);
await writeFile(outputPath, JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log("Saved the retained learning response. Inspection does not reserve an iteration; command execution uses its explicit existing approval/budget contract.");
