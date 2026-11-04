import { z } from "zod";
import {
  DecisionModelScoreRequestSchema, DecisionModelServingControlCommandSchema,
  DecisionResultSaveRequestSchema, ManagedDecisionCancelSchema, ManagedDecisionCompileSchema,
  ManagedDecisionExecutionListQuerySchema, ManagedDecisionPrepareSchema, ManagedDecisionStartSchema,
  ModelModificationCapabilitiesQuerySchema, SavedDecisionModelSelectionSchema, type createTrainingClient,
} from "openpond-sdk/training";
import { optionString, parseBooleanOption, parseIntegerOption } from "./common/options";

type Options = Record<string, string | boolean>;
const ScoreCommand = z.object({
  modelProjectId: SavedDecisionModelSelectionSchema.shape.modelProjectId,
  request: DecisionModelScoreRequestSchema,
}).strict();
export const decisionHostedActions = new Set([
  "hosted-decision-capability", "hosted-compile-decision", "hosted-prepare-decision",
  "hosted-start-decision", "hosted-cancel-decision", "hosted-decision-execution",
  "hosted-decision-executions", "hosted-save-decision-model", "hosted-score-decision",
  "hosted-decision-serving", "hosted-control-decision-serving",
]);

/** Uses the existing configured account and SDK transport. Original command
 * identities are retained by the caller; no mutation is automatically retried. */
export async function runHostedDecisionCommand(input: {
  action: string; target?: string; teamId: string; options: Options;
  client: ReturnType<typeof createTrainingClient>; readInput: () => Promise<unknown>;
}): Promise<unknown> {
  const { action, target, teamId, options, client, readInput } = input;
  if (action === "hosted-decision-execution") {
    if (!target) throw new Error("Supply the original decision execution ID.");
    return client.getDecisionExecution(teamId, target);
  }
  if (action === "hosted-decision-executions") {
    if (target) throw new Error("List decision executions using filters.");
    const query = ManagedDecisionExecutionListQuerySchema.parse(Object.fromEntries(Object.entries({
      id: optionString(options, "id") || undefined,
      projectId: optionString(options, "projectId") || undefined,
      mode: optionString(options, "mode") || undefined,
      phase: optionString(options, "phase") || undefined,
      cursor: optionString(options, "cursor") || undefined,
      limit: parseIntegerOption(options.limit, "--limit"),
    }).filter(([, value]) => value !== undefined)));
    return client.listDecisionExecutions(teamId, query);
  }
  const raw = await readInput();
  if (action === "hosted-decision-serving") {
    const selection = SavedDecisionModelSelectionSchema.parse(raw);
    return client.decisionModelServing(selection.modelProjectId, { teamId, versionHash: selection.versionHash });
  }
  if (action === "hosted-control-decision-serving") {
    const command = DecisionModelServingControlCommandSchema.parse(raw);
    if (command.request.teamId !== teamId) throw new Error("Use this Model's original workspace.");
    if (command.request.action === "activate" && !parseBooleanOption(options.yes))
      throw new Error("Activating billed decision serving capacity requires --yes.");
    return client.controlDecisionModelServing(command.modelProjectId, command.request);
  }
  if (action === "hosted-score-decision") {
    const command = ScoreCommand.parse(raw);
    if (command.request.teamId !== teamId) throw new Error("Use this Model's original workspace.");
    if (!parseBooleanOption(options.yes)) throw new Error("Billed decision scoring requires --yes.");
    return client.scoreDecisionModel(command.modelProjectId, command.request);
  }
  if (action === "hosted-decision-capability") {
    const query = ModelModificationCapabilitiesQuerySchema.parse(raw);
    if (query.teamId !== teamId) throw new Error("Use this input's original workspace.");
    return client.decisionExecutionCapability(query);
  }
  if (action === "hosted-compile-decision") {
    const command = ManagedDecisionCompileSchema.parse(raw);
    if (command.teamId !== teamId) throw new Error("Use this input's original workspace.");
    return client.compileDecisionExecution(command);
  }
  if (action === "hosted-prepare-decision") {
    const command = ManagedDecisionPrepareSchema.parse(raw);
    if (command.teamId !== teamId) throw new Error("Use this input's original workspace.");
    return client.prepareDecisionExecution(command);
  }
  if (action === "hosted-start-decision") {
    const command = ManagedDecisionStartSchema.parse(raw);
    if (command.teamId !== teamId) throw new Error("Use this execution's original workspace.");
    if (!parseBooleanOption(options.yes)) throw new Error("Starting paid decision execution requires --yes.");
    return client.startDecisionExecution(command);
  }
  if (action === "hosted-cancel-decision") {
    const command = ManagedDecisionCancelSchema.parse(raw);
    if (command.teamId !== teamId) throw new Error("Use this execution's original workspace.");
    return client.cancelDecisionExecution(command);
  }
  if (action === "hosted-save-decision-model") {
    const command = DecisionResultSaveRequestSchema.parse(raw);
    if (command.teamId !== teamId) throw new Error("Use this result's original workspace.");
    return client.saveDecisionResultModel(command);
  }
  throw new Error("Unsupported decision command.");
}
