import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { contentHash } from "@openpond/harness";
import { ToolLearningRegistrationSchema } from "openpond-sdk/tool-learning";
import { hostedTrainingAccount } from "../hosted-training-account";
import { optionString, parseBooleanOption } from "../common/options";
import { nativeToolLearningClientVersion } from "@openpond/local-server/tool-learning";
import { toolLearningHome, type ToolLearningOptions } from "./credentials";
import { externalCaptureVersion } from "./external-client";

/** One explicit opt-in creates one workspace/client installation. Collection
 * still grants neither training enrollment nor an inference allowance. */
export async function prepareToolLearningSetup(options: ToolLearningOptions) {
  if (!parseBooleanOption(options.allowUpload))
    throw new Error(
      "Tool capture uploads bounded private tool events. Pass --allow-upload to opt in.",
    );
  const client = optionString(options, "client");
  if (!["claude_code", "openpond", "codex", "opencode"].includes(client))
    throw new Error("Choose --client claude_code, codex, opencode or openpond.");
  if (!optionString(options, "environmentFile"))
    throw new Error(
      "Provide --environment-file with the actual application, version, and bounded state.",
    );
  const tools = optionString(options, "tools")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  if (!tools.length || new Set(tools).size !== tools.length)
    throw new Error("Choose the exact permitted tool names with --tools <comma-separated-names>.");
  const projectId = optionString(options, "projectId");
  if (!projectId) throw new Error("Choose an existing private Model with --project-id.");
  const workspace = await realpath(resolve(optionString(options, "workspace") || process.cwd()));
  const clientVersion =
    client === "codex" || client === "opencode" ? await externalCaptureVersion(client) : client === "claude_code"
      ? (
          await promisify(execFile)("claude", ["--version"], { timeout: 10000, maxBuffer: 65536 })
        ).stdout
          .trim()
          .split(" ")[0]!
      : nativeToolLearningClientVersion();
  if (client === "claude_code" && clientVersion !== "2.1.292")
    throw new Error(
      "This release supports Claude Code 2.1.292. Qualify a changed hook protocol before installation.",
    );
  if (clientVersion === "unknown") throw new Error("Cannot identify this OpenPond release.");
  const { baseUrl, teamId } = await hostedTrainingAccount(options);
  const identity = contentHash({
    home: toolLearningHome(options),
    api: new URL(baseUrl).origin,
    teamId,
    projectId,
    workspace,
    client,
    clientVersion,
  });
  const installationId = `tool-${identity.slice(0, 40)}`;
  return ToolLearningRegistrationSchema.parse({
    schemaVersion: "openpond.toolLearningRegistration.v1",
    operationId: `${installationId}:register`,
    installationId,
    projectId,
    machineSourceId: `machine-${contentHash(toolLearningHome(options)).slice(0, 40)}`,
    client,
    clientVersion,
    adapterRelease: {
      id: "openpond-tool-learning-v1",
      contentHash: contentHash({ protocol: "openpond-tool-learning-v1", client, clientVersion }),
    },
    collectionPolicy: {
      revision: 1,
      permittedTools: tools,
      workspaceRootHashes: [contentHash(workspace)],
      permittedFields: ["action", "intent", "state", "result_excerpt"],
      unchangedControls: { numerator: 1, denominator: 10 },
      maximumEventBytes: 65536,
      maximumEpisodeBytes: 2097152,
      maximumEpisodeEvents: 256,
      maximumQueueBytes: 1048576,
      maximumQueueEvents: 256,
      maximumQueueAgeSeconds: 86400,
      rawRetentionDays: 1,
      purposes: client === "codex" || client === "opencode" ? ["capture"] : ["capture", "consultation"],
      modelUpdates: "requires_separate_review",
      variantGeneration: "disabled",
    },
  });
}
