import { randomUUID } from "node:crypto";
import {
  createTrainingClient,
  newAlphaEditExperimentForm,
  alphaEditFormFromModelVersion,
  experimentStartingModelFromAlphaEditVersion,
  ENGRAM_TRAINING_DEFAULTS,
  EngramExperimentFormDraftSchema,
  engramFormFromModelVersion,
  experimentStartingModelFromEngramVersion,
  ExperimentDraftSchema,
  activationFormFromSteeringVersion,
  experimentStartingModelFromSteeringVersion,
  DecisionExperimentFormDraftSchema,
  decisionFormFromModelVersion,
  experimentStartingModelFromDecisionVersion,
} from "openpond-sdk/training";
import { hostedApiAuthHeaders } from "../openpond/hosted-api-access.js";
import type { ChatContextTarget } from "@openpond/contracts";

type Access = { apiBaseUrl: string; token: string; teamId: string; actorId: string };
/** The selected hosted Model is resolved using configured account authority.
 * The draft retains compact immutable pins; compile reauthorizes them. */
export async function chatSteeringExperiment(
  target: ChatContextTarget,
  access: () => Promise<Access>,
) {
  const original = await access();
  const origin = new URL(original.apiBaseUrl).origin;
  if (
    target.kind !== "model" ||
    target.location !== "cloud" ||
    target.teamId !== original.teamId ||
    target.apiOrigin !== origin
  )
    throw new Error("Choose the saved Model in its original hosted account and workspace.");
  const headers = hostedApiAuthHeaders(original.token);
  headers.set("x-openpond-team-id", original.teamId);
  const value = await createTrainingClient({
    baseUrl: original.apiBaseUrl,
    headers,
    fetch,
  }).modelVersion(target.id, { teamId: original.teamId });
  const current = await access();
  if (
    current.actorId !== original.actorId ||
    current.teamId !== original.teamId ||
    new URL(current.apiBaseUrl).origin !== origin
  )
    throw new Error("The account changed while resolving this saved Model. Select it again.");
  const version = value.version;
  if (version?.schemaVersion === "openpond.neuronTrainingModelVersion.v1")
    throw new Error(
      "This saved neuron delta supports inference. Training continuation is unavailable because optimizer state is not retained. Choose a managed base explicitly for a fresh experiment.",
    );
  if (version?.schemaVersion === "openpond.alphaEditModelVersion.v1") {
    if (version.ownerUserId !== original.actorId)
      throw new Error("Choose your exact saved AlphaEdit Model.");
    return ExperimentDraftSchema.parse({
      schemaVersion: "openpond.experimentDraft.v1",
      id: randomUUID(),
      operationType: "alphaedit",
      name: `${value.model.name} AlphaEdit experiment`,
      startingModel: await experimentStartingModelFromAlphaEditVersion(version, {
        teamId: original.teamId,
        ownerUserId: original.actorId,
        label: `${value.model.name} / Saved AlphaEdit matrices`,
      }),
      alphaEditForm: await alphaEditFormFromModelVersion(newAlphaEditExperimentForm(), version, {
        teamId: original.teamId,
        ownerUserId: original.actorId,
      }),
    });
  }
  if (version?.schemaVersion === "openpond.decisionModelVersion.v1") {
    if (version.ownerUserId !== original.actorId)
      throw new Error("Choose your exact saved decision Model.");
    return ExperimentDraftSchema.parse({
      schemaVersion: "openpond.experimentDraft.v1",
      id: randomUUID(),
      operationType: "decision_model",
      name: `${value.model.name} Decision experiment`,
      startingModel: await experimentStartingModelFromDecisionVersion(version, {
        teamId: original.teamId,
        ownerUserId: original.actorId,
        label: `${value.model.name} / Saved decision Model`,
      }),
      decisionForm: await decisionFormFromModelVersion(
        DecisionExperimentFormDraftSchema.parse({
          mode: "train",
          baseModel: null,
          batch: version.request.data.batch,
          name: "",
          maximumSpendUsd: "",
          parentArtifact: null,
          training: Object.fromEntries(
            Object.entries(version.request.training).map(([key, value]) => [key, String(value)]),
          ),
        }),
        version,
        { teamId: original.teamId, ownerUserId: original.actorId },
      ),
    });
  }
  if (version?.schemaVersion === "openpond.engramModelVersion.v1") {
    if (version.ownerUserId !== original.actorId)
      throw new Error("Choose your exact saved memory module.");
    return ExperimentDraftSchema.parse({
      schemaVersion: "openpond.experimentDraft.v1",
      id: randomUUID(),
      operationType: "engram_adapter",
      name: `${value.model.name} Engram experiment`,
      startingModel: await experimentStartingModelFromEngramVersion(version, {
        teamId: original.teamId,
        label: `${value.model.name} / Saved memory module`,
      }),
      engramForm: await engramFormFromModelVersion(
        EngramExperimentFormDraftSchema.parse({
          baseModel: null,
          batch: null,
          name: "",
          maximumSpendUsd: "",
          parentArtifact: null,
          training: Object.fromEntries(
            Object.entries(ENGRAM_TRAINING_DEFAULTS).map(([key, value]) => [key, String(value)]),
          ),
        }),
        version,
        { teamId: original.teamId },
      ),
    });
  }
  if (
    version?.schemaVersion !== "openpond.steeringModelVersion.v1" ||
    version.publication.ownerUserId !== original.actorId
  )
    throw new Error("This action requires your exact saved steering Model version.");
  return ExperimentDraftSchema.parse({
    schemaVersion: "openpond.experimentDraft.v1",
    id: randomUUID(),
    operationType: "neuron_steering",
    name: `${value.model.name} steering experiment`,
    startingModel: await experimentStartingModelFromSteeringVersion(version, {
      teamId: original.teamId,
      label: `${value.model.name} / Saved steering profile`,
    }),
    activationForm: await activationFormFromSteeringVersion(
      {
        baseModel: null,
        prompts: [{ id: randomUUID(), text: "" }],
        coordinates: [],
        doseMultipliers: "1",
        normalization: {
          mode: "baseline_prompt_residual_median",
          statistic: "midpoint_median_fp32",
          sample: "non_padding_prompt_after_position_zero",
        },
        tokenScope: { phase: "prompt_and_decode", positions: "all_non_padding" },
        maxNewTokens: "32",
        maximumCapturedValues: "65536",
        maximumForwardTokenWork: "1000000",
        maximumDurationSeconds: "300",
        maximumSpendUsd: "",
      },
      version,
      { teamId: original.teamId },
    ),
  });
}
