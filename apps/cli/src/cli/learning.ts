import { readFile } from "node:fs/promises";
import {
  OpenPondLearningClient,
  LearningCommandSchema,
  LearningBatchPublicationSchema,
  LearningResourceKindSchema,
  assertLearningRequestJson,
} from "openpond-sdk/learning";
import { hostedTrainingAccount } from "./hosted-training-account";
import { optionString } from "./common/options";

/** Operator-facing access to the existing canonical learning owner. Commands
 * are strict public SDK requests, with no second login or private HTTP client. */
export async function runLearningCommand(
  options: Record<string, string | boolean>,
  rest: string[],
) {
  const [action, kind, id] = rest;
  if (!action || !["get", "list", "command", "publish-batch"].includes(action) || rest.length > 3)
    throw new Error(
      "Use learning <get|list> <kind> [id] or learning <command|publish-batch> --input-file <path>, with --team-id.",
    );
  const { context, baseUrl, teamId } = await hostedTrainingAccount(options);
  const client = new OpenPondLearningClient({
    baseUrl,
    apiKey: context.token,
    scope: teamId,
    fetch: (url, init) =>
      fetch(url, {
        ...init,
        signal: init?.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(60000)])
          : AbortSignal.timeout(60000),
      }),
  });
  let result: unknown;
  if (action === "get" || action === "list") {
    const resource = LearningResourceKindSchema.parse(kind);
    if (action === "get") {
      if (!id) throw new Error("Select a learning resource ID.");
      const revision = optionString(options, "revision");
      result = await client.get(resource, id, revision ? Number(revision) : undefined);
    } else {
      if (id) throw new Error("List accepts a resource kind, with --after-id for pagination.");
      result = await client.list(resource, {
        limit: Number(optionString(options, "limit") || "30"),
        ...(optionString(options, "afterId") ? { afterId: optionString(options, "afterId") } : {}),
        ...(optionString(options, "parentId")
          ? { parentId: optionString(options, "parentId") }
          : {}),
        ...(optionString(options, "status") ? { status: optionString(options, "status") } : {}),
      });
    }
  } else {
    if (kind || id)
      throw new Error(
        "This action takes --input-file rather than positional resource identifiers.",
      );
    const path = optionString(options, "inputFile");
    if (!path) throw new Error("Select --input-file <absolute-json-path>.");
    const bytes = await readFile(path);
    if (bytes.byteLength > 16777216) throw new Error("Learning input exceeds 16 MiB.");
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    assertLearningRequestJson(value);
    result =
      action === "command"
        ? await client.command(LearningCommandSchema.parse(value))
        : await client.publishBatch(LearningBatchPublicationSchema.parse(value));
  }
  console.log(JSON.stringify(result, null, 2));
}
