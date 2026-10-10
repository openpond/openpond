import { readFile, stat } from "node:fs/promises";
import {
  DatasetPreparationCommandSchema,
  DatasetPreparationCreateSchema,
  DatasetPreparationGrantCreateSchema,
  type OpenPondDatasetPreparationClient,
} from "openpond-sdk/dataset-workspaces";
import { optionString } from "./common";

export const DATASET_PREPARATION_USAGE =
  "datasets preparation <grant-create|grant-read|create|read|list|candidates|operation|start|pause|resume|cancel|resolve|release> <dataset-id> [run-or-grant-id] --team <id> --api-base-url <origin> [--input-file <path>] [--operation-id <id>] [--expected-revision <n>] [--cursor <id>]";

/** CLI delegates authentication and every operation to the existing Dataset
 * client. It never runs reconstruction or authoring in a separate launcher. */
export async function runDatasetPreparationCommand(
  client: OpenPondDatasetPreparationClient,
  options: Record<string, string | boolean>,
  rest: string[],
) {
  const [action, datasetId, runId] = rest;
  if (!datasetId || !action || rest.length > 3)
    throw new Error(`usage: ${DATASET_PREPARATION_USAGE}`);
  const cursor = optionString(options, "cursor") || undefined;
  let result: unknown;
  if (action === "grant-create") {
    if (runId)
      throw new Error("Grant creation takes its identity from the input file.");
    result = await client.createGrant(
      datasetId,
      DatasetPreparationGrantCreateSchema.parse(
        await readPreparationInput(options),
      ),
    );
  } else if (action === "grant-read") {
    if (!runId) throw new Error("Grant read requires the retained grant ID.");
    result = await client.getGrant(datasetId, runId);
  } else if (action === "create") {
    if (runId)
      throw new Error(
        "Create derives its run identity from the saved operation ID.",
      );
    result = await client.create(
      datasetId,
      DatasetPreparationCreateSchema.parse(await readPreparationInput(options)),
    );
  } else if (action === "list") {
    if (runId) throw new Error("List accepts a Dataset ID only.");
    result = await client.list(datasetId, { cursor });
  } else if (action === "operation") {
    const operationId = optionString(options, "operationId");
    if (runId || !operationId)
      throw new Error(
        "Operation recovery requires --operation-id and no run ID.",
      );
    result = await client.operationResult(datasetId, operationId);
  } else {
    if (!runId)
      throw new Error(`${action} requires the retained preparation run ID.`);
    if (action === "read") result = await client.get(datasetId, runId);
    else if (action === "candidates")
      result = await client.candidates(datasetId, runId, { cursor });
    else {
      const request =
        action === "resolve"
          ? DatasetPreparationCommandSchema.parse(
              await readPreparationInput(options),
            )
          : DatasetPreparationCommandSchema.parse({
              action,
              operationId: optionString(options, "operationId"),
              expectedRevision: Number(
                optionString(options, "expectedRevision"),
              ),
            });
      if (request.action !== action)
        throw new Error(
          "Input-file action differs from the selected preparation command.",
        );
      result = await client.command(datasetId, runId, request);
    }
  }
  console.log(JSON.stringify(result, null, 2));
}

async function readPreparationInput(options: Record<string, string | boolean>) {
  const file = optionString(options, "inputFile");
  if (!file || (await stat(file)).size > 1_048_576)
    throw new Error(
      "Preparation requires a bounded --input-file containing its saved policy or resolution command.",
    );
  const bytes = await readFile(file);
  if (bytes.byteLength > 1_048_576)
    throw new Error("Preparation input exceeds one MiB.");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
