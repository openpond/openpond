import {
  AlphaEditResultSaveRequestSchema, ManagedAlphaEditCompileSchema, ManagedAlphaEditPrepareSchema,
  AlphaEditModelServingControlCommandSchema,
  ManagedAlphaEditStartSchema, ManagedAlphaEditCancelSchema, ManagedAlphaEditExecutionListQuerySchema,
  SavedWeightModelSelectionSchema, ModelModificationCapabilitiesQuerySchema, type createTrainingClient,
} from "openpond-sdk/training";
import { optionString, parseBooleanOption, parseIntegerOption } from "./common/options";

type Options = Record<string, string | boolean>;
export const alphaEditHostedActions = new Set([
  "hosted-alphaedit-capability", "hosted-compile-alphaedit", "hosted-prepare-alphaedit",
  "hosted-start-alphaedit", "hosted-cancel-alphaedit", "hosted-alphaedit-execution",
  "hosted-alphaedit-executions", "hosted-save-alphaedit-model",
  "hosted-control-alphaedit-serving", "hosted-alphaedit-serving",
]);

/** Uses the configured authenticated SDK. Preparation and saving never start
 * training or serving; paid start retains its original plan/revision/cap. */
export async function runHostedAlphaEditCommand(input: {
  action: string; target?: string; teamId: string; options: Options;
  client: ReturnType<typeof createTrainingClient>; readInput: () => Promise<unknown>;
}): Promise<unknown> {
  const { action, target, teamId, options, client, readInput } = input;
  if (action === "hosted-alphaedit-execution") {
    if (!target) throw new Error("Supply the original AlphaEdit execution ID.");
    return client.getAlphaEditExecution(teamId, target);
  }
  if (action === "hosted-alphaedit-executions") {
    if (target) throw new Error("List AlphaEdit executions using filters.");
    const query = ManagedAlphaEditExecutionListQuerySchema.parse(Object.fromEntries(Object.entries({
      id: optionString(options, "id") || undefined,
      projectId: optionString(options, "projectId") || undefined,
      phase: optionString(options, "phase") || undefined,
      cursor: optionString(options, "cursor") || undefined,
      limit: parseIntegerOption(options.limit, "--limit"),
    }).filter(([, value]) => value !== undefined)));
    return client.listAlphaEditExecutions(teamId, query);
  }
  const raw = await readInput();
  if (action === "hosted-alphaedit-serving") {
    const selection = SavedWeightModelSelectionSchema.parse(raw);
    return client.alphaEditModelServing(selection.modelProjectId, { teamId, versionHash: selection.versionHash });
  }
  if (action === "hosted-control-alphaedit-serving") {
    const command = AlphaEditModelServingControlCommandSchema.parse(raw);
    if (command.request.teamId !== teamId) throw new Error("Use the Model's original workspace.");
    if (command.request.action === "activate" && !parseBooleanOption(options.yes))
      throw new Error("Activating billed serving capacity requires --yes.");
    return client.controlAlphaEditModelServing(command.modelProjectId, command.request);
  }
  if (action === "hosted-alphaedit-capability") {
    const query = ModelModificationCapabilitiesQuerySchema.parse(raw);
    if (query.teamId !== teamId) throw new Error("Use this input's original workspace.");
    return client.alphaEditExecutionCapability(query);
  }
  if (action === "hosted-compile-alphaedit") {
    const command = ManagedAlphaEditCompileSchema.parse(raw);
    if (command.teamId !== teamId) throw new Error("Use this input's original workspace.");
    return client.compileAlphaEditExecution(command);
  }
  if (action === "hosted-prepare-alphaedit") {
    const command = ManagedAlphaEditPrepareSchema.parse(raw);
    if (command.teamId !== teamId) throw new Error("Use this input's original workspace.");
    return client.prepareAlphaEditExecution(command);
  }
  if (action === "hosted-start-alphaedit") {
    const command = ManagedAlphaEditStartSchema.parse(raw);
    if (command.teamId !== teamId) throw new Error("Use this execution's original workspace.");
    if (!parseBooleanOption(options.yes)) throw new Error("Starting paid AlphaEdit execution requires --yes.");
    return client.startAlphaEditExecution(command);
  }
  if (action === "hosted-cancel-alphaedit") {
    const command = ManagedAlphaEditCancelSchema.parse(raw);
    if (command.teamId !== teamId) throw new Error("Use this execution's original workspace.");
    return client.cancelAlphaEditExecution(command);
  }
  if (action === "hosted-save-alphaedit-model") {
    const command = AlphaEditResultSaveRequestSchema.parse(raw);
    if (command.teamId !== teamId) throw new Error("Use this result's original workspace.");
    return client.saveAlphaEditResultModel(command);
  }
  throw new Error("Unsupported AlphaEdit command.");
}
