import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { DatasetPreparationAuthoringRequestSchema } from "openpond-sdk/taskset-drafts";
import { createTaskAuthoringMessages, parseTaskAuthoringDecision } from "./training/task-authoring-model.js";
import { loadTasksetAuthoringSkillArtifact } from "./training/task-authoring-skill.js";

/** Private, bounded embedded CLI bridge to the existing authoring owner.
 * It neither authenticates nor dispatches model, grader or training work. */
export async function runDatasetPreparationAuthoringCli(argv: string[]) {
  if (argv.length !== 1 || !path.isAbsolute(argv[0]!)) throw new Error("Dataset preparation requires one absolute private request-file path.");
  const file = argv[0]!;
  if (await realpath(file) !== file) throw new Error("Dataset preparation request path must not contain symbolic links.");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  const maximum = 4 * 1024 * 1024;
  let bytes: Buffer;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximum || (stat.mode & 0o077) !== 0 || process.getuid && stat.uid !== process.getuid())
      throw new Error("Dataset preparation request is not a bounded private file.");
    const buffer = Buffer.alloc(maximum + 1);
    let received = 0;
    while (received < buffer.length) {
      const read = await handle.read(buffer, received, buffer.length - received, received);
      if (read.bytesRead === 0) break;
      received += read.bytesRead;
    }
    if (received > maximum) throw new Error("Dataset preparation request changed beyond its byte limit.");
    bytes = buffer.subarray(0, received);
  } finally { await handle.close(); }
  const request = DatasetPreparationAuthoringRequestSchema.parse(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)));
  const artifact = await loadTasksetAuthoringSkillArtifact();
  let result;
  try {
    result = request.action === "messages"
    ? { messages: createTaskAuthoringMessages({ id: request.id, evidence: request.evidence,
      skillText: artifact.bundle, buildIntent: "verifiable_reward", buildSpecification: request.buildSpecification,
      methodHint: "grpo", instruction: request.instruction, currentProposal: request.currentProposal }), skillHash: artifact.contentHash }
      : { proposal: parseTaskAuthoringDecision(request.content, request.evidence), skillHash: artifact.contentHash };
  } catch (error) {
    if (request.action !== "validate") throw error;
    process.stdout.write(`${JSON.stringify({ error: { code: "dataset_preparation_authoring_proposal_invalid" } })}\n`);
    process.exitCode = 2;
    return;
  }
  const output = JSON.stringify(result);
  if (Buffer.byteLength(output) > 4 * 1024 * 1024) throw new Error("Dataset preparation authoring response exceeds its byte limit.");
  process.stdout.write(`${output}\n`);
}
