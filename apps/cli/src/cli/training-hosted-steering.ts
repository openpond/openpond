import {
  NeuronCalibrationArchiveRequestSchema,
  NeuronCalibrationImportRequestSchema,
  SavedSteeringModelSelectionSchema,
  SteeringModelServingControlCommandSchema,
  type createTrainingClient,
} from "openpond-sdk/training";
import { optionString, parseBooleanOption, parseIntegerOption } from "./common/options";

type Options = Record<string, string | boolean>;
export const steeringHostedActions = new Set([
  "hosted-saved-model-serving", "hosted-control-steering-serving",
  "hosted-import-calibration", "hosted-calibration", "hosted-calibrations", "hosted-archive-calibration",
]);

/** Reuse the caller's authenticated SDK and input owner. No secondary account,
 * automatic retry or provider operation is introduced here. */
export async function runHostedSteeringCommand(input: {
  action: string; target?: string; teamId: string; options: Options;
  client: ReturnType<typeof createTrainingClient>; readInput: () => Promise<unknown>;
}): Promise<unknown> {
  const { action, target, teamId, options, client, readInput } = input;
  if (action === "hosted-calibration") {
    if (!target) throw new Error("Supply the original calibration ID.");
    return client.getNeuronCalibration(teamId, target);
  }
  if (action === "hosted-calibrations") {
    if (target) throw new Error("Use filters to list calibration history.");
    return client.listNeuronCalibrations(teamId, {
      projectId: optionString(options, "projectId") || undefined,
      modelHash: optionString(options, "modelHash") || undefined,
      archived: parseBooleanOption(options.archived),
      cursor: optionString(options, "cursor") || undefined,
      limit: parseIntegerOption(options.limit, "--limit"),
    });
  }
  if (action === "hosted-saved-model-serving") {
    const selection = SavedSteeringModelSelectionSchema.parse(await readInput());
    return client.savedModelServing(selection.modelProjectId, { teamId, versionHash: selection.versionHash });
  }
  if (action === "hosted-control-steering-serving") {
    const command = SteeringModelServingControlCommandSchema.parse(await readInput());
    if (command.request.teamId !== teamId) throw new Error("Use the Model's original workspace.");
    if (command.request.action === "activate" && !parseBooleanOption(options.yes))
      throw new Error("Activating billed serving capacity requires --yes.");
    return client.controlSteeringModelServing(command.modelProjectId, command.request);
  }
  if (action === "hosted-import-calibration") {
    const command = NeuronCalibrationImportRequestSchema.parse(await readInput());
    if (command.teamId !== teamId) throw new Error("Use the calibration's original workspace.");
    return client.importNeuronCalibration(command);
  }
  if (action === "hosted-archive-calibration") {
    const raw = await readInput();
    if (!raw || typeof raw !== "object" || !("id" in raw) || typeof raw.id !== "string" || !("request" in raw))
      throw new Error("Supply the calibration ID and original archive request.");
    const command = NeuronCalibrationArchiveRequestSchema.parse(raw.request);
    if (command.teamId !== teamId) throw new Error("Use the calibration's original workspace.");
    return client.archiveNeuronCalibration(raw.id, command);
  }
  throw new Error("Unsupported steering command.");
}
