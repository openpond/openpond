import path from "node:path";

import { optionString, parseBooleanOption } from "./common/options";
import { resolveApiBaseUrlOption } from "./common/urls";
import {
  createLocalAuthenticatedRequest,
  DEFAULT_LOCAL_TRAINING_API_URL,
  TrainingApiClient,
} from "./training";

export async function runTasksetCommand(
  options: Record<string, string | boolean>,
  rest: string[],
  dependencies: { request?: typeof fetch } = {},
): Promise<void> {
  const [subcommand, identifier] = rest;
  if (
    !subcommand
    || !identifier
    || rest.length !== 2
    || !["import", "publish", "readiness", "delete-draft"].includes(subcommand)
  ) {
    throw new Error(
      "usage: taskset <import|publish|readiness|delete-draft> <package-path|draft-id|taskset-id> [--profile <id>] [--model <id>] [--json]",
    );
  }
  const baseUrl = resolveApiBaseUrlOption(options)
    ?? process.env.OPENPOND_LOCAL_API_URL?.replace(/\/$/, "")
    ?? DEFAULT_LOCAL_TRAINING_API_URL;
  const target = new URL(baseUrl);
  if (
    target.protocol !== "http:"
    || !["127.0.0.1", "localhost", "::1"].includes(target.hostname)
  ) {
    throw new Error("Taskset package import is available only through the local OpenPond app API.");
  }
  const client = new TrainingApiClient({
    baseUrl,
    request: dependencies.request ?? await createLocalAuthenticatedRequest(baseUrl),
  });
  const result = subcommand === "import"
    ? await client.importTasksetDraftPackage({
        packagePath: path.resolve(identifier),
        profileId: optionString(options, "profile") || "default",
      })
    : subcommand === "publish"
      ? await client.publishTasksetDraft(
          identifier,
          optionString(options, "model") || null,
        )
      : subcommand === "readiness"
        ? await client.tasksetReadiness(identifier)
        : await client.deleteTasksetDraft(identifier);
  if (parseBooleanOption(options.json)) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const record = result && typeof result === "object"
    ? result as Record<string, unknown>
    : {};
  if (subcommand === "import") {
    console.log(`Imported Taskset draft ${String(record.name ?? record.id ?? identifier)}.`);
    console.log("Open it in Models → Tasksets to review it, or publish it with the OpenPond CLI.");
    return;
  }
  if (subcommand === "publish") {
    const taskset = record.taskset && typeof record.taskset === "object"
      ? record.taskset as Record<string, unknown>
      : {};
    console.log(`Published Taskset ${String(taskset.name ?? taskset.id ?? identifier)}.`);
    return;
  }
  if (subcommand === "readiness") {
    console.log(`Checked Taskset ${identifier} readiness.`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Deleted unpublished Taskset draft ${identifier}.`);
}
