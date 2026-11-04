import {
  EngramResultSaveRequestSchema, ManagedEngramCompileSchema, ManagedEngramPrepareSchema,
  EngramModelServingControlCommandSchema,
  ManagedEngramStartSchema, ManagedEngramCancelSchema, ManagedEngramExecutionListQuerySchema,
  ModelModificationCapabilitiesQuerySchema, type createTrainingClient,
} from "openpond-sdk/training";
import { optionString, parseBooleanOption, parseIntegerOption } from "./common/options";

type Options = Record<string, string | boolean>;
export const engramHostedActions = new Set([
  "hosted-engram-capability", "hosted-compile-engram", "hosted-prepare-engram",
  "hosted-start-engram", "hosted-cancel-engram", "hosted-engram-execution",
  "hosted-engram-executions", "hosted-save-engram-model",
  "hosted-control-engram-serving",
]);

/** Uses the configured authenticated SDK. Preparation and saving never start
 * training or serving; paid start retains its original plan/revision/cap. */
export async function runHostedEngramCommand(input: {
  action: string; target?: string; teamId: string; options: Options;
  client: ReturnType<typeof createTrainingClient>; readInput: () => Promise<unknown>;
}): Promise<unknown> {
  const { action, target, teamId, options, client, readInput } = input;
  if (action === "hosted-engram-execution") {
    if (!target) throw new Error("Supply the original Engram execution ID.");
    return client.getEngramExecution(teamId, target);
  }
  if (action === "hosted-engram-executions") {
    if (target) throw new Error("List Engram executions using filters.");
    const query = ManagedEngramExecutionListQuerySchema.parse(Object.fromEntries(Object.entries({
      id: optionString(options, "id") || undefined,
      projectId: optionString(options, "projectId") || undefined,
      phase: optionString(options, "phase") || undefined,
      cursor: optionString(options, "cursor") || undefined,
      limit: parseIntegerOption(options.limit, "--limit"),
    }).filter(([, value]) => value !== undefined)));
    return client.listEngramExecutions(teamId, query);
  }
  const raw = await readInput();
  if (action === "hosted-control-engram-serving") {
    const command = EngramModelServingControlCommandSchema.parse(raw);
    if (command.request.teamId !== teamId) throw new Error("Use the Model's original workspace.");
    if (command.request.action === "activate" && !parseBooleanOption(options.yes))
      throw new Error("Activating billed serving capacity requires --yes.");
    return client.controlEngramModelServing(command.modelProjectId, command.request);
  }
  if (action === "hosted-engram-capability") {
    const query = ModelModificationCapabilitiesQuerySchema.parse(raw);
    if (query.teamId !== teamId) throw new Error("Use this input's original workspace.");
    return client.engramExecutionCapability(query);
  }
  if (action === "hosted-compile-engram") {
    const command = ManagedEngramCompileSchema.parse(raw);
    if (command.teamId !== teamId) throw new Error("Use this input's original workspace.");
    return client.compileEngramExecution(command);
  }
  if (action === "hosted-prepare-engram") {
    const command = ManagedEngramPrepareSchema.parse(raw);
    if (command.teamId !== teamId) throw new Error("Use this input's original workspace.");
    return client.prepareEngramExecution(command);
  }
  if (action === "hosted-start-engram") {
    const command = ManagedEngramStartSchema.parse(raw);
    if (command.teamId !== teamId) throw new Error("Use this execution's original workspace.");
    if (!parseBooleanOption(options.yes)) throw new Error("Starting paid Engram training requires --yes.");
    return client.startEngramExecution(command);
  }
  if (action === "hosted-cancel-engram") {
    const command = ManagedEngramCancelSchema.parse(raw);
    if (command.teamId !== teamId) throw new Error("Use this execution's original workspace.");
    return client.cancelEngramExecution(command);
  }
  if (action === "hosted-save-engram-model") {
    const command = EngramResultSaveRequestSchema.parse(raw);
    if (command.teamId !== teamId) throw new Error("Use this result's original workspace.");
    return client.saveEngramResultModel(command);
  }
  throw new Error("Unsupported Engram command.");
}
