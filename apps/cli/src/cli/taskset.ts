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
  const [subcommand, packagePath] = rest;
  if (subcommand !== "import" || !packagePath || rest.length !== 2) {
    throw new Error("usage: taskset import <package-directory|taskset.json> [--profile <id>] [--json]");
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
  const imported = await client.importTasksetDraftPackage({
    packagePath: path.resolve(packagePath),
    profileId: optionString(options, "profile") ?? "default",
  });
  if (parseBooleanOption(options.json)) {
    console.log(JSON.stringify(imported, null, 2));
    return;
  }
  const record = imported && typeof imported === "object"
    ? imported as Record<string, unknown>
    : {};
  console.log(`Imported Taskset draft ${String(record.name ?? record.id ?? packagePath)}.`);
  console.log("Open it in Models → Tasksets to review and publish it.");
}
