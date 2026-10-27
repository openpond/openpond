import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { learningRef, type OpenPondLearningClient } from "openpond-sdk/learning";
import { type createModelProjectsClient } from "openpond-sdk/model-projects";
import { TrainingGpuSelectionSchema, type createTrainingClient } from "openpond-sdk/training";
import { optionString, parseBooleanOption, parseNumberOption } from "./common/options";

type Options = Record<string, string | boolean>;

export function trainingGpuChoice(options: Options) {
  const gpuType = optionString(options, "gpuType");
  const availabilityId = optionString(options, "availabilityId");
  const objective = optionString(options, "gpuPlacementObjective");
  const gpuCount = parseNumberOption(options.gpuCount, "gpu-count");
  if (gpuCount !== undefined && gpuCount !== 1 && gpuCount !== 2)
    throw new Error("--gpu-count must be 1 or 2.");
  if (gpuType || availabilityId) {
    if (!gpuType || !availabilityId || objective)
      throw new Error("Choose --gpu-type with --availability-id, or --gpu-placement-objective.");
    return TrainingGpuSelectionSchema.parse({ mode: "manual", gpuType, availabilityId, ...(gpuCount !== undefined ? { gpuCount } : {}) });
  }
  return objective || gpuCount !== undefined
    ? TrainingGpuSelectionSchema.parse({ mode: "automatic", objective: objective ?? "balanced", ...(gpuCount !== undefined ? { gpuCount } : {}) }) : undefined;
}

/** Resolves immutable reviewed inputs through the authenticated SDK. Only the
 * caller's explicit or saved budget becomes the cap. */
export async function startHostedModel(input: {
  options: Options;
  modelId: string;
  teamId: string;
  client: ReturnType<typeof createTrainingClient>;
  models: ReturnType<typeof createModelProjectsClient>;
  learning: OpenPondLearningClient;
}) {
  const { options, client, teamId } = input;
  const batchId = optionString(options, "batchId");
  if (!batchId) throw new Error("training start --team-id requires --batch-id <sealed-approved-batch-id>.");
  const interactive = process.stdin.isTTY && process.stdout.isTTY && !parseBooleanOption(options.json);
  const yes = parseBooleanOption(options.yes);
  if (!yes && !interactive) throw new Error("Noninteractive training start requires --yes and an explicitly approved --max-spend or saved budget.");
  for (const flag of ["manifest", "comparisonSeriesEntry", "retentionDays", "exportApproved"]) {
    if (options[flag] !== undefined) throw new Error(`Hosted saved-Model starts use the retained configuration; ${flag} is not a run override.`);
  }
  const [{ project }, batch] = await Promise.all([
    input.models.get(input.modelId), input.learning.get("batch", batchId),
  ]);
  const gpuSelection = trainingGpuChoice(options) ?? project.trainingSetup.managedGpuSelection;
  let cap = parseNumberOption(options.maxSpend, "max-spend") ?? project.trainingSetup.preferredMaximumSpendUsd;
  if (interactive && !yes) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await prompt.question(`Maximum budget in USD${cap === null ? "" : ` [${cap}]`}: `);
      if (answer.trim()) cap = Number(answer.trim());
    } finally { prompt.close(); }
  }
  if (cap === null || !Number.isFinite(cap) || cap <= 0 || cap > 1_000_000)
    throw new Error("Choose an explicit positive --max-spend or save a positive Model budget before starting.");
  const preparation = await client.prepareRun({
    schemaVersion: "openpond.trainingPreparationRequest.v1", teamId,
    operationId: optionString(options, "operationId") || randomUUID(),
    projectId: optionString(options, "projectId") || null,
    configuration: { id: project.id, expectedRevision: project.revision, expectedEtag: project.etag },
    batch: learningRef(batch), name: optionString(options, "name") || project.name,
    maximumSpendUsd: cap,
    ...(gpuSelection ? { gpuSelection } : {}),
  });
  if (!parseBooleanOption(options.json)) console.log(`Retained preparation: ${preparation.plan.id}`);
  if (!parseBooleanOption(options.json)) {
    console.log(`Prepared run: ${preparation.plan.id}; approved maximum $${cap}.`);
    console.log(`Model: ${project.name}@${preparation.plan.source.modelProject.revision}; batch: ${preparation.plan.request.batch.id}@${preparation.plan.request.batch.revision}.`);
    console.log(`GPU choice: ${gpuSelection?.mode === "manual" ? `${gpuSelection.gpuType} / ${gpuSelection.availabilityId}` : `Automatic (${gpuSelection?.objective ?? project.trainingSetup.managedGpuPlacementObjective})`}; count ${gpuSelection?.gpuCount ?? 1}.`);
  }
  if (!yes) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const confirmed = await prompt.question(`Start this exact prepared run with a $${cap} maximum? [y/N] `);
      if (!["y", "yes"].includes(confirmed.trim().toLowerCase()))
        throw new Error(`Training was not started. Preparation ${preparation.plan.id} is retained for review or cancellation.`);
    } finally { prompt.close(); }
  }
  // Do not repeat this mutation after a lost response. The retained preparation
  // is the recovery handle and the backend owns exactly-once submission.
  const submitted = await client.startPreparation(preparation.plan.id, {
    teamId, planHash: preparation.plan.contentHash, expectedRevision: preparation.revision,
  });
  return { preparation: submitted };
}
