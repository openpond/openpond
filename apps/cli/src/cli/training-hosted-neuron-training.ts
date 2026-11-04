import {
  NeuronTrainingResultSaveRequestSchema, ManagedNeuronTrainingCompileSchema, ManagedNeuronTrainingPrepareSchema,
  NeuronTrainingModelServingControlCommandSchema,
  ManagedNeuronTrainingStartSchema, ManagedNeuronTrainingCancelSchema, ManagedNeuronTrainingExecutionListQuerySchema,
  SavedWeightModelSelectionSchema, ModelModificationCapabilitiesQuerySchema, type createTrainingClient,
} from "openpond-sdk/training";
import { optionString, parseBooleanOption, parseIntegerOption } from "./common/options";

type Options = Record<string, string | boolean>;
export const neuronTrainingHostedActions = new Set([
  "hosted-neuron-training-capability", "hosted-compile-neuron-training", "hosted-prepare-neuron-training",
  "hosted-start-neuron-training", "hosted-cancel-neuron-training", "hosted-neuron-training-execution",
  "hosted-neuron-training-executions", "hosted-save-neuron-training-model",
  "hosted-control-neuron-training-serving", "hosted-neuron-training-serving",
]);

/** Uses the configured authenticated SDK. Preparation and saving never start
 * training or serving; paid start retains its original plan/revision/cap. */
export async function runHostedNeuronTrainingCommand(input: {
  action: string; target?: string; teamId: string; options: Options;
  client: ReturnType<typeof createTrainingClient>; readInput: () => Promise<unknown>;
}): Promise<unknown> {
  const { action, target, teamId, options, client, readInput } = input;
  if (action === "hosted-neuron-training-execution") {
    if (!target) throw new Error("Supply the original NeuronTraining execution ID.");
    return client.getNeuronTrainingExecution(teamId, target);
  }
  if (action === "hosted-neuron-training-executions") {
    if (target) throw new Error("List NeuronTraining executions using filters.");
    const query = ManagedNeuronTrainingExecutionListQuerySchema.parse(Object.fromEntries(Object.entries({
      id: optionString(options, "id") || undefined,
      projectId: optionString(options, "projectId") || undefined,
      phase: optionString(options, "phase") || undefined,
      cursor: optionString(options, "cursor") || undefined,
      limit: parseIntegerOption(options.limit, "--limit"),
    }).filter(([, value]) => value !== undefined)));
    return client.listNeuronTrainingExecutions(teamId, query);
  }
  const raw = await readInput();
  if (action === "hosted-neuron-training-serving") {
    const selection = SavedWeightModelSelectionSchema.parse(raw);
    return client.neuronTrainingModelServing(selection.modelProjectId, { teamId, versionHash: selection.versionHash });
  }
  if (action === "hosted-control-neuron-training-serving") {
    const command = NeuronTrainingModelServingControlCommandSchema.parse(raw);
    if (command.request.teamId !== teamId) throw new Error("Use the Model's original workspace.");
    if (command.request.action === "activate" && !parseBooleanOption(options.yes))
      throw new Error("Activating billed serving capacity requires --yes.");
    return client.controlNeuronTrainingModelServing(command.modelProjectId, command.request);
  }
  if (action === "hosted-neuron-training-capability") {
    const query = ModelModificationCapabilitiesQuerySchema.parse(raw);
    if (query.teamId !== teamId) throw new Error("Use this input's original workspace.");
    return client.neuronTrainingExecutionCapability(query);
  }
  if (action === "hosted-compile-neuron-training") {
    const command = ManagedNeuronTrainingCompileSchema.parse(raw);
    if (command.teamId !== teamId) throw new Error("Use this input's original workspace.");
    return client.compileNeuronTrainingExecution(command);
  }
  if (action === "hosted-prepare-neuron-training") {
    const command = ManagedNeuronTrainingPrepareSchema.parse(raw);
    if (command.teamId !== teamId) throw new Error("Use this input's original workspace.");
    return client.prepareNeuronTrainingExecution(command);
  }
  if (action === "hosted-start-neuron-training") {
    const command = ManagedNeuronTrainingStartSchema.parse(raw);
    if (command.teamId !== teamId) throw new Error("Use this execution's original workspace.");
    if (!parseBooleanOption(options.yes)) throw new Error("Starting paid selective neuron training execution requires --yes.");
    return client.startNeuronTrainingExecution(command);
  }
  if (action === "hosted-cancel-neuron-training") {
    const command = ManagedNeuronTrainingCancelSchema.parse(raw);
    if (command.teamId !== teamId) throw new Error("Use this execution's original workspace.");
    return client.cancelNeuronTrainingExecution(command);
  }
  if (action === "hosted-save-neuron-training-model") {
    const command = NeuronTrainingResultSaveRequestSchema.parse(raw);
    if (command.teamId !== teamId) throw new Error("Use this result's original workspace.");
    return client.saveNeuronTrainingResultModel(command);
  }
  throw new Error("Unsupported NeuronTraining command.");
}
