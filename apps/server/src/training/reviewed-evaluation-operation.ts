import { WeightSpaceCancelIntentSchema } from "@openpond/contracts";
import { WeightSpaceModelServingControlIntentSchema, WeightSpaceModelServingControlCommandSchema } from "openpond-sdk/training";
import { WeightSpaceModelSaveIntentSchema } from "@openpond/contracts";
import { WeightSpaceResultSaveRequestSchema } from "openpond-sdk/training";
import type { ManagedModificationPrice } from "openpond-sdk/training";
import {
  AlphaEditModelServingControlIntentSchema,
  AlphaEditModelServingControlCommandSchema,
  NeuronTrainingModelServingControlIntentSchema,
  NeuronTrainingModelServingControlCommandSchema,
} from "openpond-sdk/training";
import {
  AlphaEditResultSaveRequestSchema,
  ManagedAlphaEditPrepareSchema,
  ManagedAlphaEditStartSchema,
  ManagedAlphaEditCancelSchema,
} from "openpond-sdk/training";
import {
  AlphaEditModelSaveIntentSchema,
  AlphaEditExperimentPrepareIntentSchema,
  AlphaEditExperimentControlIntentSchema,
} from "@openpond/contracts";
import {
  NeuronTrainingResultSaveRequestSchema,
  ManagedNeuronTrainingPrepareSchema,
  ManagedNeuronTrainingStartSchema,
  ManagedNeuronTrainingCancelSchema,
} from "openpond-sdk/training";
import {
  NeuronTrainingModelSaveIntentSchema,
  NeuronTrainingExperimentPrepareIntentSchema,
  NeuronTrainingExperimentControlIntentSchema,
} from "@openpond/contracts";
import {
  DecisionModelServingControlIntentSchema,
  DecisionModelServingControlCommandSchema,
  DecisionResultSaveRequestSchema,
  ManagedDecisionPrepareSchema,
  ManagedDecisionStartSchema,
  ManagedDecisionCancelSchema,
} from "openpond-sdk/training";
import {
  DecisionModelSaveIntentSchema,
  DecisionExperimentPrepareIntentSchema,
  DecisionExperimentControlIntentSchema,
  DecisionModelScoreIntentSchema,
  DecisionModelScoreCommandSchema,
} from "@openpond/contracts";
import {
  EngramModelServingControlIntentSchema,
  EngramModelServingControlCommandSchema,
} from "openpond-sdk/training";
import { EngramResultSaveRequestSchema } from "openpond-sdk/training";
import { EngramModelSaveIntentSchema } from "@openpond/contracts";
import {
  ManagedEngramPrepareSchema,
  ManagedEngramStartSchema,
  ManagedEngramCancelSchema,
} from "openpond-sdk/training";
import {
  EngramExperimentPrepareIntentSchema,
  EngramExperimentControlIntentSchema,
} from "@openpond/contracts";
import {
  SteeringProfileSaveRequestSchema,
  canonicalJson as protocolJson,
  ManagedModificationPrepareSchema,
  ManagedModificationStartSchema,
  ManagedModificationCancelSchema,
} from "openpond-sdk/training";
import {
  SteeringModelSaveIntentSchema,
  ActivationExperimentPrepareIntentSchema,
  ActivationExperimentControlIntentSchema,
} from "@openpond/contracts";
import {
  SteeringModelServingControlIntentSchema,
  SteeringModelServingControlCommandSchema,
  TrainingResultSaveIntentSchema,
  TrainingResultSaveCommandSchema,
  TrainingModelServingControlIntentSchema,
  TrainingModelServingControlCommandSchema,
  TrainingExperimentSetupRequestSchema,
} from "openpond-sdk/training";
import {
  TrainingExperimentRecoveryIntentSchema,
  TrainingExperimentControlIntentSchema,
  TrainingExperimentControlCommandSchema,
} from "@openpond/contracts";
import { contentHash, sha256 } from "@openpond/harness";
import { z } from "zod";
import {
  AdvancedRefinerEvaluationCommandSchema,
  AdvancedRefinerEvaluationPrepareSchema,
  verifyAdvancedRefinerEvaluationPin,
} from "openpond-sdk/advanced-refiner-evaluations";
import {
  ExperimentEvaluationScheduleInputSchema,
  ExperimentEvaluationScheduleCommandSchema,
} from "openpond-sdk/experiment-evaluation-schedules";
const ServingIntent = z.union([
  AlphaEditModelServingControlIntentSchema,
  NeuronTrainingModelServingControlIntentSchema,
  WeightSpaceModelServingControlIntentSchema,
  DecisionModelServingControlIntentSchema,
  EngramModelServingControlIntentSchema,
  TrainingModelServingControlIntentSchema,
  SteeringModelServingControlIntentSchema,
]);
const ServingCommand = z.union([
  AlphaEditModelServingControlCommandSchema,
  NeuronTrainingModelServingControlCommandSchema,
  WeightSpaceModelServingControlCommandSchema,
  DecisionModelServingControlCommandSchema,
  EngramModelServingControlCommandSchema,
  TrainingModelServingControlCommandSchema,
  SteeringModelServingControlCommandSchema,
]);
const AdvancedIntent = AdvancedRefinerEvaluationPrepareSchema.omit({
  operation: true,
  operationId: true,
})
  .extend({ localModelId: z.string().min(1), modelId: z.string().min(1) })
  .strict();
const ScheduleControlIntent = z
  .object({
    id: z.string().min(1),
    revision: z.number().int().nonnegative(),
    action: z.enum(["pause", "cancel_active", "retry_active"]),
  })
  .strict();
/** A durable Start must retain the price actually shown in its reviewed plan.
 * Both new intent creation and retained-command replay pass this boundary. */
function assertReviewedModificationPrice(intent: {
  execution: { plan: { computePrice?: ManagedModificationPrice } };
  request: { action: "start" | "cancel"; approvedPriceHash?: string };
}) {
  if (intent.request.action !== "start") return;
  const price = intent.execution.plan.computePrice;
  const expected = price ? sha256(protocolJson(price)) : undefined;
  if (intent.request.approvedPriceHash !== expected)
    throw new Error("The Start approval differs from the usage price in the reviewed plan.");
}

export function validateReviewedEvaluationIntent(
  action: string,
  raw: unknown,
  scope: { actorId: string; teamId: string; projectId: string | null },
) {
  if (action === "training-decision-result-save") {
    const intent = DecisionModelSaveIntentSchema.parse(raw);
    if (
      intent.account.actorId !== scope.actorId ||
      intent.account.teamId !== scope.teamId ||
      intent.execution.projectId !== scope.projectId
    )
      throw new Error("The reviewed Model save belongs to another creator, workspace or Project.");
    return intent;
  }
  if (action === "training-alphaedit-result-save") {
    const intent = AlphaEditModelSaveIntentSchema.parse(raw);
    if (
      intent.account.actorId !== scope.actorId ||
      intent.account.teamId !== scope.teamId ||
      intent.execution.projectId !== scope.projectId
    )
      throw new Error("The reviewed Model save belongs to another creator, workspace or Project.");
    return intent;
  }
  if (action === "training-neuron-training-result-save") {
    const intent = NeuronTrainingModelSaveIntentSchema.parse(raw);
    if (
      intent.account.actorId !== scope.actorId ||
      intent.account.teamId !== scope.teamId ||
      intent.execution.projectId !== scope.projectId
    )
      throw new Error("The reviewed Model save belongs to another creator, workspace or Project.");
    return intent;
  }
  if(action === "training-weight-space-cancel"){
    const intent=WeightSpaceCancelIntentSchema.parse(raw);
    if(intent.account.actorId!==scope.actorId||intent.account.teamId!==scope.teamId||intent.execution.projectId!==scope.projectId)
      throw new Error("The editing cancellation belongs to another account or Project.");
    return intent;
  }
  if (action === "training-weight-space-result-save") {
    const intent = WeightSpaceModelSaveIntentSchema.parse(raw);
    if (
      intent.account.actorId !== scope.actorId ||
      intent.account.teamId !== scope.teamId ||
      intent.execution.projectId !== scope.projectId
    )
      throw new Error("The reviewed Model save belongs to another creator, workspace or Project.");
    return intent;
  }
  if (action === "training-engram-result-save") {
    const intent = EngramModelSaveIntentSchema.parse(raw);
    if (
      intent.account.actorId !== scope.actorId ||
      intent.account.teamId !== scope.teamId ||
      intent.execution.projectId !== scope.projectId
    )
      throw new Error("The reviewed Model save belongs to another creator, workspace or Project.");
    return intent;
  }
  if (action === "training-steering-result-save") {
    const intent = SteeringModelSaveIntentSchema.parse(raw);
    if (
      intent.account.actorId !== scope.actorId ||
      intent.account.teamId !== scope.teamId ||
      intent.execution.projectId !== scope.projectId
    )
      throw new Error("The reviewed Model save belongs to another creator, workspace or Project.");
    return intent;
  }
  if (action === "training:prepare-decision") {
    const intent = DecisionExperimentPrepareIntentSchema.parse(raw);
    if (
      intent.account.actorId !== scope.actorId ||
      intent.account.teamId !== scope.teamId ||
      intent.request.projectId !== scope.projectId
    )
      throw new Error(
        "The reviewed Decision preparation belongs to another account, workspace or Project.",
      );
    return intent;
  }
  if (action === "training:prepare-alphaedit") {
    const intent = AlphaEditExperimentPrepareIntentSchema.parse(raw);
    if (
      intent.account.actorId !== scope.actorId ||
      intent.account.teamId !== scope.teamId ||
      intent.request.projectId !== scope.projectId
    )
      throw new Error(
        "The reviewed AlphaEdit preparation belongs to another account, workspace or Project.",
      );
    return intent;
  }
  if (action === "training:prepare-neuron-training") {
    const intent = NeuronTrainingExperimentPrepareIntentSchema.parse(raw);
    if (
      intent.account.actorId !== scope.actorId ||
      intent.account.teamId !== scope.teamId ||
      intent.request.projectId !== scope.projectId
    )
      throw new Error(
        "The reviewed NeuronTraining preparation belongs to another account, workspace or Project.",
      );
    return intent;
  }
  if (action === "training:prepare-engram") {
    const intent = EngramExperimentPrepareIntentSchema.parse(raw);
    if (
      intent.account.actorId !== scope.actorId ||
      intent.account.teamId !== scope.teamId ||
      intent.request.projectId !== scope.projectId
    )
      throw new Error(
        "The reviewed Engram preparation belongs to another account, workspace or Project.",
      );
    return intent;
  }
  if (action === "training:start-decision" || action === "training:cancel-decision") {
    const intent = DecisionExperimentControlIntentSchema.parse(raw);
    assertReviewedModificationPrice(intent);
    if (
      intent.account.actorId !== scope.actorId ||
      intent.account.teamId !== scope.teamId ||
      intent.execution.projectId !== scope.projectId ||
      intent.request.action !== (action === "training:start-decision" ? "start" : "cancel") ||
      (intent.preparationOperationId !== null &&
        intent.execution.id !==
          `modification-${sha256(protocolJson({ teamId: scope.teamId, ownerUserId: scope.actorId, operationId: intent.preparationOperationId }))}`)
    )
      throw new Error(
        "The reviewed Decision control differs from its original preparation, account or Project.",
      );
    return intent;
  }
  if (action === "training:start-alphaedit" || action === "training:cancel-alphaedit") {
    const intent = AlphaEditExperimentControlIntentSchema.parse(raw);
    assertReviewedModificationPrice(intent);
    if (
      intent.account.actorId !== scope.actorId ||
      intent.account.teamId !== scope.teamId ||
      intent.execution.projectId !== scope.projectId ||
      intent.request.action !== (action === "training:start-alphaedit" ? "start" : "cancel") ||
      (intent.preparationOperationId !== null &&
        intent.execution.id !==
          `modification-${sha256(protocolJson({ teamId: scope.teamId, ownerUserId: scope.actorId, operationId: intent.preparationOperationId }))}`)
    )
      throw new Error(
        "The reviewed AlphaEdit control differs from its original preparation, account or Project.",
      );
    return intent;
  }
  if (action === "training:start-neuron-training" || action === "training:cancel-neuron-training") {
    const intent = NeuronTrainingExperimentControlIntentSchema.parse(raw);
    assertReviewedModificationPrice(intent);
    if (
      intent.account.actorId !== scope.actorId ||
      intent.account.teamId !== scope.teamId ||
      intent.execution.projectId !== scope.projectId ||
      intent.request.action !==
        (action === "training:start-neuron-training" ? "start" : "cancel") ||
      (intent.preparationOperationId !== null &&
        intent.execution.id !==
          `modification-${sha256(protocolJson({ teamId: scope.teamId, ownerUserId: scope.actorId, operationId: intent.preparationOperationId }))}`)
    )
      throw new Error(
        "The reviewed NeuronTraining control differs from its original preparation, account or Project.",
      );
    return intent;
  }
  if (action === "training:start-engram" || action === "training:cancel-engram") {
    const intent = EngramExperimentControlIntentSchema.parse(raw);
    assertReviewedModificationPrice(intent);
    if (
      intent.account.actorId !== scope.actorId ||
      intent.account.teamId !== scope.teamId ||
      intent.execution.projectId !== scope.projectId ||
      intent.request.action !== (action === "training:start-engram" ? "start" : "cancel") ||
      (intent.preparationOperationId !== null &&
        intent.execution.id !==
          `modification-${sha256(protocolJson({ teamId: scope.teamId, ownerUserId: scope.actorId, operationId: intent.preparationOperationId }))}`)
    )
      throw new Error(
        "The reviewed Engram control differs from its original preparation, account or Project.",
      );
    return intent;
  }
  if (action === "training:prepare-modification") {
    const intent = ActivationExperimentPrepareIntentSchema.parse(raw);
    if (
      intent.account.actorId !== scope.actorId ||
      intent.account.teamId !== scope.teamId ||
      intent.request.projectId !== scope.projectId
    )
      throw new Error(
        "The reviewed activation preparation belongs to another account, workspace or Project.",
      );
    return intent;
  }
  if (action === "training:start-modification" || action === "training:cancel-modification") {
    const intent = ActivationExperimentControlIntentSchema.parse(raw);
    assertReviewedModificationPrice(intent);
    if (
      intent.account.actorId !== scope.actorId ||
      intent.account.teamId !== scope.teamId ||
      intent.execution.projectId !== scope.projectId ||
      intent.request.action !== (action === "training:start-modification" ? "start" : "cancel") ||
      (intent.preparationOperationId !== null &&
        intent.execution.id !==
          `modification-${sha256(protocolJson({ teamId: scope.teamId, ownerUserId: scope.actorId, operationId: intent.preparationOperationId }))}`)
    )
      throw new Error(
        "The reviewed activation control differs from its original preparation, account or Project.",
      );
    return intent;
  }
  if (action === "training:prepare-draft") {
    const intent = TrainingExperimentRecoveryIntentSchema.parse(raw);
    if (intent.request.teamId !== scope.teamId || intent.request.projectId !== scope.projectId)
      throw new Error("The reviewed training preparation belongs to another workspace or Project.");
    return intent;
  }
  if (action === "training:control-preparation") {
    const intent = TrainingExperimentControlIntentSchema.parse(raw);
    if (
      intent.receipt.plan.creatorUserId !== scope.actorId ||
      intent.receipt.plan.request.teamId !== scope.teamId ||
      intent.receipt.plan.request.projectId !== scope.projectId
    )
      throw new Error(
        "The reviewed training control belongs to another creator, workspace or Project.",
      );
    return intent;
  }
  if (action === "training-decision-score") {
    const intent = DecisionModelScoreIntentSchema.parse(raw);
    if (intent.account.actorId !== scope.actorId || intent.account.teamId !== scope.teamId)
      throw new Error("The reviewed score belongs to another original account or workspace.");
    return intent;
  }
  if (action === "training-model-serving-control") return ServingIntent.parse(raw);
  if (action === "training-result-save") return TrainingResultSaveIntentSchema.parse(raw);
  if (action === "advanced-refiner-start") return AdvancedIntent.parse(raw);
  if (action !== "experiment-evaluation-schedule")
    throw new Error("This action does not retain reviewed payloads.");
  const control = ScheduleControlIntent.safeParse(raw);
  if (control.success) return control.data;
  const input = z.record(z.string(), z.unknown()).parse(raw),
    { operationId: _id, ...body } = ExperimentEvaluationScheduleInputSchema.parse({
      ...input,
      operationId: "reviewed-intent",
    });
  return body;
}
/** Only canonical public commands/refs enter the durable device journal. Private
 * source/holdout bytes and connection credentials are never command fields. */
export function validateReviewedEvaluationCommand(input: {
  action: string;
  id: string;
  actorId: string;
  teamId: string;
  projectId: string | null;
  intent: unknown;
  command: unknown;
}) {
  if (input.action === "training-decision-result-save") {
    const intent = DecisionModelSaveIntentSchema.parse(
      validateReviewedEvaluationIntent(input.action, input.intent, input),
    );
    const command = DecisionResultSaveRequestSchema.parse(input.command),
      { operationId, ...request } = command;
    if (operationId !== input.id || contentHash(request) !== contentHash(intent.request))
      throw new Error(
        "The retained Model save differs from its original result, module or destination revision.",
      );
    return command;
  }
  if (input.action === "training-alphaedit-result-save") {
    const intent = AlphaEditModelSaveIntentSchema.parse(
      validateReviewedEvaluationIntent(input.action, input.intent, input),
    );
    const command = AlphaEditResultSaveRequestSchema.parse(input.command),
      { operationId, ...request } = command;
    if (operationId !== input.id || contentHash(request) !== contentHash(intent.request))
      throw new Error(
        "The retained Model save differs from its original result, module or destination revision.",
      );
    return command;
  }
  if (input.action === "training-neuron-training-result-save") {
    const intent = NeuronTrainingModelSaveIntentSchema.parse(
      validateReviewedEvaluationIntent(input.action, input.intent, input),
    );
    const command = NeuronTrainingResultSaveRequestSchema.parse(input.command),
      { operationId, ...request } = command;
    if (operationId !== input.id || contentHash(request) !== contentHash(intent.request))
      throw new Error(
        "The retained Model save differs from its original result, module or destination revision.",
      );
    return command;
  }
  if(input.action === "training-weight-space-cancel"){
    const intent=WeightSpaceCancelIntentSchema.parse(validateReviewedEvaluationIntent(input.action,input.intent,input));
    const command=ManagedModificationCancelSchema.parse(input.command);
    if(command.operationId!==input.id||command.id!==intent.execution.id||command.teamId!==intent.account.teamId
      ||command.planHash!==intent.execution.plan.contentHash||command.expectedRevision!==intent.execution.revision)
      throw new Error("Retry the original editing session cancellation command.");
    return command;
  }
  if (input.action === "training-weight-space-result-save") {
    const intent = WeightSpaceModelSaveIntentSchema.parse(
      validateReviewedEvaluationIntent(input.action, input.intent, input),
    );
    const command = WeightSpaceResultSaveRequestSchema.parse(input.command),
      { operationId, ...request } = command;
    if (operationId !== input.id || contentHash(request) !== contentHash(intent.request))
      throw new Error(
        "The retained Model save differs from its original result, module or destination revision.",
      );
    return command;
  }
  if (input.action === "training-engram-result-save") {
    const intent = EngramModelSaveIntentSchema.parse(
      validateReviewedEvaluationIntent(input.action, input.intent, input),
    );
    const command = EngramResultSaveRequestSchema.parse(input.command),
      { operationId, ...request } = command;
    if (operationId !== input.id || contentHash(request) !== contentHash(intent.request))
      throw new Error(
        "The retained Model save differs from its original result, module or destination revision.",
      );
    return command;
  }
  if (input.action === "training-steering-result-save") {
    const intent = SteeringModelSaveIntentSchema.parse(
      validateReviewedEvaluationIntent(input.action, input.intent, input),
    );
    const command = SteeringProfileSaveRequestSchema.parse(input.command),
      { operationId, ...request } = command;
    if (operationId !== input.id || contentHash(request) !== contentHash(intent.request))
      throw new Error(
        "The retained Model save differs from its original result, variant, profile or destination revision.",
      );
    return command;
  }
  if (input.action === "training:prepare-decision") {
    const intent = DecisionExperimentPrepareIntentSchema.parse(
        validateReviewedEvaluationIntent(input.action, input.intent, input),
      ),
      command = ManagedDecisionPrepareSchema.parse(input.command);
    const { operationId, ...body } = command;
    if (operationId !== input.id || contentHash(body) !== contentHash(intent.request))
      throw new Error(
        "The retained Decision preparation differs from its exact compiled request, form or spending cap.",
      );
    return command;
  }
  if (input.action === "training:prepare-alphaedit") {
    const intent = AlphaEditExperimentPrepareIntentSchema.parse(
        validateReviewedEvaluationIntent(input.action, input.intent, input),
      ),
      command = ManagedAlphaEditPrepareSchema.parse(input.command);
    const { operationId, ...body } = command;
    if (operationId !== input.id || contentHash(body) !== contentHash(intent.request))
      throw new Error(
        "The retained AlphaEdit preparation differs from its exact compiled request, form or spending cap.",
      );
    return command;
  }
  if (input.action === "training:prepare-neuron-training") {
    const intent = NeuronTrainingExperimentPrepareIntentSchema.parse(
        validateReviewedEvaluationIntent(input.action, input.intent, input),
      ),
      command = ManagedNeuronTrainingPrepareSchema.parse(input.command);
    const { operationId, ...body } = command;
    if (operationId !== input.id || contentHash(body) !== contentHash(intent.request))
      throw new Error(
        "The retained NeuronTraining preparation differs from its exact compiled request, form or spending cap.",
      );
    return command;
  }
  if (input.action === "training:prepare-engram") {
    const intent = EngramExperimentPrepareIntentSchema.parse(
        validateReviewedEvaluationIntent(input.action, input.intent, input),
      ),
      command = ManagedEngramPrepareSchema.parse(input.command);
    const { operationId, ...body } = command;
    if (operationId !== input.id || contentHash(body) !== contentHash(intent.request))
      throw new Error(
        "The retained Engram preparation differs from its exact compiled request, form or spending cap.",
      );
    return command;
  }
  if (input.action === "training:start-decision" || input.action === "training:cancel-decision") {
    const intent = DecisionExperimentControlIntentSchema.parse(
      validateReviewedEvaluationIntent(input.action, input.intent, input),
    );
    const command =
      input.action === "training:start-decision"
        ? ManagedDecisionStartSchema.parse(input.command)
        : ManagedDecisionCancelSchema.parse(input.command);
    const { operationId, ...body } = command;
    if (operationId !== input.id || contentHash(body) !== contentHash(intent.request))
      throw new Error(
        "The retained Decision control differs from its original reviewed execution or approval.",
      );
    return command;
  }
  if (input.action === "training:start-alphaedit" || input.action === "training:cancel-alphaedit") {
    const intent = AlphaEditExperimentControlIntentSchema.parse(
      validateReviewedEvaluationIntent(input.action, input.intent, input),
    );
    const command =
      input.action === "training:start-alphaedit"
        ? ManagedAlphaEditStartSchema.parse(input.command)
        : ManagedAlphaEditCancelSchema.parse(input.command);
    const { operationId, ...body } = command;
    if (operationId !== input.id || contentHash(body) !== contentHash(intent.request))
      throw new Error(
        "The retained AlphaEdit control differs from its original reviewed execution or approval.",
      );
    return command;
  }
  if (
    input.action === "training:start-neuron-training" ||
    input.action === "training:cancel-neuron-training"
  ) {
    const intent = NeuronTrainingExperimentControlIntentSchema.parse(
      validateReviewedEvaluationIntent(input.action, input.intent, input),
    );
    const command =
      input.action === "training:start-neuron-training"
        ? ManagedNeuronTrainingStartSchema.parse(input.command)
        : ManagedNeuronTrainingCancelSchema.parse(input.command);
    const { operationId, ...body } = command;
    if (operationId !== input.id || contentHash(body) !== contentHash(intent.request))
      throw new Error(
        "The retained NeuronTraining control differs from its original reviewed execution or approval.",
      );
    return command;
  }
  if (input.action === "training:start-engram" || input.action === "training:cancel-engram") {
    const intent = EngramExperimentControlIntentSchema.parse(
      validateReviewedEvaluationIntent(input.action, input.intent, input),
    );
    const command =
      input.action === "training:start-engram"
        ? ManagedEngramStartSchema.parse(input.command)
        : ManagedEngramCancelSchema.parse(input.command);
    const { operationId, ...body } = command;
    if (operationId !== input.id || contentHash(body) !== contentHash(intent.request))
      throw new Error(
        "The retained Engram control differs from its original reviewed execution or approval.",
      );
    return command;
  }
  if (input.action === "training:prepare-modification") {
    const intent = ActivationExperimentPrepareIntentSchema.parse(
        validateReviewedEvaluationIntent(input.action, input.intent, input),
      ),
      command = ManagedModificationPrepareSchema.parse(input.command);
    const { operationId, ...body } = command;
    if (operationId !== input.id || contentHash(body) !== contentHash(intent.request))
      throw new Error(
        "The retained activation preparation differs from its exact compiled request, form or spending cap.",
      );
    return command;
  }
  if (
    input.action === "training:start-modification" ||
    input.action === "training:cancel-modification"
  ) {
    const intent = ActivationExperimentControlIntentSchema.parse(
      validateReviewedEvaluationIntent(input.action, input.intent, input),
    );
    const command =
      input.action === "training:start-modification"
        ? ManagedModificationStartSchema.parse(input.command)
        : ManagedModificationCancelSchema.parse(input.command);
    const { operationId, ...body } = command;
    if (operationId !== input.id || contentHash(body) !== contentHash(intent.request))
      throw new Error(
        "The retained activation control differs from its original reviewed execution or approval.",
      );
    return command;
  }
  if (input.action === "training:prepare-draft") {
    const intent = TrainingExperimentRecoveryIntentSchema.parse(input.intent),
      command = TrainingExperimentSetupRequestSchema.parse(input.command);
    const { operationId, ...body } = command;
    if (
      operationId !== input.id ||
      command.teamId !== input.teamId ||
      command.projectId !== input.projectId ||
      contentHash(body) !== contentHash(intent.request)
    )
      throw new Error(
        "The retained training preparation differs from its original model, settings or workspace.",
      );
    return command;
  }
  if (input.action === "training:control-preparation") {
    const intent = TrainingExperimentControlIntentSchema.parse(input.intent),
      command = TrainingExperimentControlCommandSchema.parse(input.command);
    if (
      intent.receipt.plan.creatorUserId !== input.actorId ||
      intent.receipt.plan.request.teamId !== input.teamId ||
      intent.receipt.plan.request.projectId !== input.projectId ||
      contentHash(command) !== contentHash(intent.command)
    )
      throw new Error(
        "The retained training control differs from its original creator, preparation or approved estimate.",
      );
    return command;
  }
  if (input.action === "training-decision-score") {
    const intent = DecisionModelScoreIntentSchema.parse(
      validateReviewedEvaluationIntent(input.action, input.intent, input),
    );
    const command = DecisionModelScoreCommandSchema.parse(input.command),
      { requestId, ...request } = command.request;
    if (
      requestId !== input.id ||
      command.modelProjectId !== intent.modelProjectId ||
      contentHash(request) !== contentHash(intent.request)
    )
      throw new Error(
        "The retained score differs from its original typed input, limits or exact Model version.",
      );
    return command;
  }
  if (input.action === "training-model-serving-control") {
    const intent = ServingIntent.parse(input.intent),
      command = ServingCommand.parse(input.command);
    const { operationId, ...body } = command.request;
    if (
      operationId !== input.id ||
      body.teamId !== input.teamId ||
      contentHash({ ...body, modelProjectId: command.modelProjectId }) !== contentHash(intent)
    )
      throw new Error(
        "The retained serving command differs from its reviewed Model, checkpoint or action.",
      );
    return command;
  }
  if (input.action === "training-result-save") {
    const intent = TrainingResultSaveIntentSchema.parse(input.intent),
      command = TrainingResultSaveCommandSchema.parse(input.command);
    const { operationId, ...body } = command.request;
    if (
      operationId !== input.id ||
      body.teamId !== input.teamId ||
      contentHash({ ...body, jobId: command.jobId }) !== contentHash(intent)
    )
      throw new Error(
        "The retained Model save differs from its reviewed checkpoint, name or account.",
      );
    return command;
  }
  if (input.action === "advanced-refiner-start") {
    const intent = AdvancedIntent.parse(input.intent);
    const command = AdvancedRefinerEvaluationCommandSchema.parse(input.command);
    if (command.operation !== "start")
      throw new Error("This retained action requires its reviewed advanced Start.");
    const request = command.request,
      pin = verifyAdvancedRefinerEvaluationPin(request.pin);
    if (
      pin.operationId !== input.id ||
      pin.actorId !== input.actorId ||
      pin.teamId !== input.teamId ||
      pin.projectId !== input.projectId ||
      request.modelId !== intent.localModelId ||
      request.model.providerId !== "openpond" ||
      request.model.modelId !== intent.modelId ||
      contentHash(pin.evidence) !== contentHash(intent.evidence) ||
      pin.mode !== intent.mode ||
      pin.adaptationSplit !== intent.adaptationSplit ||
      contentHash(pin.refinerRelease) !== contentHash(intent.refinerRelease) ||
      pin.maximumCostUsd !== intent.maximumCostUsd ||
      pin.maximumDurationMs !== intent.maximumDurationMs ||
      pin.maximumModelSteps !== intent.maximumModelSteps ||
      pin.profileRef.profileId !== request.profileId
    )
      throw new Error(
        "The retained advanced command differs from its original reviewed authority or limits.",
      );
    return command;
  }
  if (input.action !== "experiment-evaluation-schedule")
    throw new Error("This action cannot retain reviewed evaluation commands.");
  const command = ExperimentEvaluationScheduleCommandSchema.parse(input.command);
  if (command.operation === "publish") {
    const { operationId, ...intent } = command.request;
    if (
      operationId !== input.id ||
      command.request.teamId !== input.teamId ||
      command.request.projectId !== input.projectId ||
      contentHash(intent) !== contentHash(input.intent)
    )
      throw new Error("The retained schedule command differs from its exact reviewed intent.");
  } else if (command.operation === "control") {
    const intent = ScheduleControlIntent.parse(input.intent);
    if (
      command.request.operationId !== input.id ||
      command.request.teamId !== input.teamId ||
      command.request.id !== intent.id ||
      command.request.expectedRevision !== intent.revision ||
      command.request.action !== intent.action
    )
      throw new Error("The retained schedule control changed its reviewed revision.");
  } else throw new Error("Only explicit schedule publication/control enters operation recovery.");
  return command;
}
