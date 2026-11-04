import {
  createHostedAlphaEditPublication,
  HostedAlphaEditPublicationEnvelopeSchema,
} from "../training/hosted-alphaedit-publication.js";
import {
  createHostedAlphaEditExecutions,
  HostedAlphaEditExecutionEnvelopeSchema,
  HostedAlphaEditExecutionError,
} from "../training/hosted-alphaedit-executions.js";
import {
  AlphaEditModelSaveIntentSchema,
  AlphaEditExperimentControlIntentSchema,
} from "@openpond/contracts";
import {
  createHostedNeuronTrainingPublication,
  HostedNeuronTrainingPublicationEnvelopeSchema,
} from "../training/hosted-neuron-training-publication.js";
import {
  createHostedNeuronTrainingExecutions,
  HostedNeuronTrainingExecutionEnvelopeSchema,
  HostedNeuronTrainingExecutionError,
} from "../training/hosted-neuron-training-executions.js";
import {
  NeuronTrainingModelSaveIntentSchema,
  NeuronTrainingExperimentControlIntentSchema,
} from "@openpond/contracts";
import {
  createHostedDecisionScoring,
  HostedDecisionScoringEnvelopeSchema,
} from "../training/hosted-decision-scoring.js";
import {
  createHostedDecisionPublication,
  HostedDecisionPublicationEnvelopeSchema,
} from "../training/hosted-decision-publication.js";
import {
  createHostedDecisionExecutions,
  HostedDecisionExecutionEnvelopeSchema,
  HostedDecisionExecutionError,
} from "../training/hosted-decision-executions.js";
import {
  DecisionModelScoreIntentSchema,
  DecisionModelSaveIntentSchema,
  DecisionExperimentControlIntentSchema,
} from "@openpond/contracts";
import {
  createHostedEngramPublication,
  HostedEngramPublicationEnvelopeSchema,
} from "../training/hosted-engram-publication.js";
import { EngramModelSaveIntentSchema } from "@openpond/contracts";
import {
  createHostedEngramExecutions,
  HostedEngramExecutionEnvelopeSchema,
  HostedEngramExecutionError,
} from "../training/hosted-engram-executions.js";
import { EngramExperimentControlIntentSchema } from "@openpond/contracts";
import {
  createHostedSteeringPublication,
  HostedSteeringPublicationEnvelopeSchema,
} from "../training/hosted-steering-publication.js";
import {
  SteeringModelSaveIntentSchema,
  ActivationExperimentAccountSchema,
  ActivationExperimentControlIntentSchema,
} from "@openpond/contracts";
import { contentHash } from "@openpond/harness";
import {
  createHostedModificationExecutions,
  HostedModificationExecutionEnvelopeSchema,
  HostedModificationExecutionError,
} from "../training/hosted-modification-executions.js";
import { validateReviewedEvaluationCommand } from "../training/reviewed-evaluation-operation.js";
import {
  HumanRevokeLocalPublicationSchema,
  HumanLocalPublicationsReadSchema,
  HumanExportLocalRequestSchema,
  HumanShareLocalRequestSchema,
} from "@openpond/evals/human-review";
import {
  revokeLocalHumanPublication,
  shareLocalHumanEvidence,
  readLocalHumanPublicationRefs,
} from "./local-sharing.js";
import { exportLocalHumanEvidence } from "./local-export.js";
import { z } from "zod";
import { createHostedCandidateEvaluations } from "../training/hosted-candidate-evaluations.js";
import { createHostedExperimentTrainingHandoff } from "../training/experiment-training-handoff.js";
import { createHostedTrainingSetup } from "../training/hosted-training-setup.js";
import { OpenPondTrainingProjectClient } from "openpond-sdk/training-projects";
import { HostedTrainingSetupActionSchema } from "openpond-sdk/post-training";
import { createExecutionActivityService } from "../training/execution-activity.js";
import { readHostedExecutionActivity } from "../training/hosted-execution-activity.js";
import { createHostedHumanReviewBridge } from "./hosted-bridge.js";
import { createHostedTrainingDetailTransport } from "./hosted-training-detail-transport.js";
import { createLocalHumanReviewRuntime } from "./runtime.js";
import type { createLocalExperimentService } from "../evaluations/local-experiment-service.js";
import type { createTrainingApi } from "../training/training-api.js";
import type { SqliteStore } from "../store/store.js";

/** Shared transports retain the active account/workspace authority at I/O. */
export function createReviewAndActivityTransport(deps: {
  store: SqliteStore;
  storeDir: string;
  localExperiments: ReturnType<typeof createLocalExperimentService>;
  actorId: () => Promise<string>;
  teamId: () => Promise<string>;
  resolveAccess: () => Promise<{ apiBaseUrl: string; token: string }>;
  trainingRequest: ReturnType<typeof createTrainingApi>["request"];
  humanReview?: ReturnType<typeof createLocalHumanReviewRuntime>;
}): ReturnType<typeof createTrainingApi>["request"] {
  const trainingDetailRequest = createHostedTrainingDetailTransport(deps);
  const local = deps.humanReview ?? createLocalHumanReviewRuntime(deps);
  const hosted = createHostedHumanReviewBridge({
    resolveAccess: async () => ({ ...(await deps.resolveAccess()), teamId: await deps.teamId() }),
  });
  const activity = createExecutionActivityService({
    ...deps,
    authorizeProject: async (teamId, _actorId, projectId) => {
      const access = await deps.resolveAccess();
      await new OpenPondTrainingProjectClient({
        baseUrl: access.apiBaseUrl,
        apiKey: access.token,
        teamId,
      }).get(projectId);
    },
    hosted: async (teamId, projectId) =>
      readHostedExecutionActivity(await deps.resolveAccess(), teamId, projectId),
  });
  return async (action, payload, requestUrl, signal) => {
    if (action === "hosted_alphaedit_publication") {
      const body = HostedAlphaEditPublicationEnvelopeSchema.parse(payload);
      const [teamId, actorId, access] = await Promise.all([
        deps.teamId(),
        deps.actorId(),
        deps.resolveAccess(),
      ]);
      const apiOrigin = new URL(access.apiBaseUrl).origin;
      return createHostedAlphaEditPublication({
        teamId,
        actorId,
        access,
        currentIdentity: async () => ({
          teamId: await deps.teamId(),
          actorId: await deps.actorId(),
          apiOrigin: (await deps.resolveAccess()).apiBaseUrl,
        }),
        assertRetained: async (command, intentHash, projectId) => {
          const retained = await deps.store.readPendingEvaluationOperation({
            scopeHash: contentHash({ actorId, apiOrigin, teamId, projectId }),
            action: "training-alphaedit-result-save",
            intentHash,
            id: command.operationId,
          });
          if (
            retained.phase !== "dispatching" ||
            contentHash(retained.command) !== contentHash(command)
          )
            throw new HostedAlphaEditExecutionError(
              "alphaedit_save_review_required",
              "Recover the original reviewed Model save before dispatch.",
            );
          const intent = AlphaEditModelSaveIntentSchema.parse(retained.reviewedIntent);
          if (contentHash(intent.account) !== contentHash({ teamId, actorId, apiOrigin }))
            throw new HostedAlphaEditExecutionError(
              "alphaedit_save_account_changed",
              "Return to this Model save's original account.",
            );
          validateReviewedEvaluationCommand({
            action: "training-alphaedit-result-save",
            id: command.operationId,
            actorId,
            teamId,
            projectId,
            intent: retained.reviewedIntent,
            command,
          });
        },
      }).perform(body);
    }
    if (action === "hosted_alphaedit_execution") {
      const body = HostedAlphaEditExecutionEnvelopeSchema.parse(payload);
      const [teamId, actorId, access] = await Promise.all([
        deps.teamId(),
        deps.actorId(),
        deps.resolveAccess(),
      ]);
      const apiOrigin = new URL(access.apiBaseUrl).origin;
      return createHostedAlphaEditExecutions({
        teamId,
        actorId,
        access,
        currentIdentity: async () => ({
          teamId: await deps.teamId(),
          actorId: await deps.actorId(),
          apiOrigin: (await deps.resolveAccess()).apiBaseUrl,
        }),
        assertRetained: async ({ action, command, intentHash, projectId }) => {
          const actionName = `training:${action}-alphaedit`;
          const retained = await deps.store.readPendingEvaluationOperation({
            scopeHash: contentHash({ actorId, apiOrigin, teamId, projectId }),
            action: actionName,
            intentHash,
            id: command.operationId,
          });
          if (
            retained.phase !== "dispatching" ||
            contentHash(retained.command) !== contentHash(command)
          )
            throw new HostedAlphaEditExecutionError(
              "alphaedit_review_required",
              "Recover the exact reviewed experiment operation before dispatch.",
            );
          const retainedAccount = ActivationExperimentAccountSchema.parse(
            z.object({ account: z.unknown() }).parse(retained.reviewedIntent).account,
          );
          if (contentHash(retainedAccount) !== contentHash({ teamId, actorId, apiOrigin }))
            throw new HostedAlphaEditExecutionError(
              "alphaedit_account_changed",
              "The retained experiment belongs to another original account.",
            );
          validateReviewedEvaluationCommand({
            action: actionName,
            id: command.operationId,
            actorId,
            teamId,
            projectId,
            intent: retained.reviewedIntent,
            command,
          });
          if (action === "prepare") return null;
          const original = AlphaEditExperimentControlIntentSchema.parse(retained.reviewedIntent);
          return original.preparationOperationId === null ? original.execution : null;
        },
      }).perform(body);
    }
    if (action === "hosted_neuron_training_publication") {
      const body = HostedNeuronTrainingPublicationEnvelopeSchema.parse(payload);
      const [teamId, actorId, access] = await Promise.all([
        deps.teamId(),
        deps.actorId(),
        deps.resolveAccess(),
      ]);
      const apiOrigin = new URL(access.apiBaseUrl).origin;
      return createHostedNeuronTrainingPublication({
        teamId,
        actorId,
        access,
        currentIdentity: async () => ({
          teamId: await deps.teamId(),
          actorId: await deps.actorId(),
          apiOrigin: (await deps.resolveAccess()).apiBaseUrl,
        }),
        assertRetained: async (command, intentHash, projectId) => {
          const retained = await deps.store.readPendingEvaluationOperation({
            scopeHash: contentHash({ actorId, apiOrigin, teamId, projectId }),
            action: "training-neuron-training-result-save",
            intentHash,
            id: command.operationId,
          });
          if (
            retained.phase !== "dispatching" ||
            contentHash(retained.command) !== contentHash(command)
          )
            throw new HostedNeuronTrainingExecutionError(
              "neuron_training_save_review_required",
              "Recover the original reviewed Model save before dispatch.",
            );
          const intent = NeuronTrainingModelSaveIntentSchema.parse(retained.reviewedIntent);
          if (contentHash(intent.account) !== contentHash({ teamId, actorId, apiOrigin }))
            throw new HostedNeuronTrainingExecutionError(
              "neuron_training_save_account_changed",
              "Return to this Model save's original account.",
            );
          validateReviewedEvaluationCommand({
            action: "training-neuron-training-result-save",
            id: command.operationId,
            actorId,
            teamId,
            projectId,
            intent: retained.reviewedIntent,
            command,
          });
        },
      }).perform(body);
    }
    if (action === "hosted_neuron_training_execution") {
      const body = HostedNeuronTrainingExecutionEnvelopeSchema.parse(payload);
      const [teamId, actorId, access] = await Promise.all([
        deps.teamId(),
        deps.actorId(),
        deps.resolveAccess(),
      ]);
      const apiOrigin = new URL(access.apiBaseUrl).origin;
      return createHostedNeuronTrainingExecutions({
        teamId,
        actorId,
        access,
        currentIdentity: async () => ({
          teamId: await deps.teamId(),
          actorId: await deps.actorId(),
          apiOrigin: (await deps.resolveAccess()).apiBaseUrl,
        }),
        assertRetained: async ({ action, command, intentHash, projectId }) => {
          const actionName = `training:${action}-neuron-training`;
          const retained = await deps.store.readPendingEvaluationOperation({
            scopeHash: contentHash({ actorId, apiOrigin, teamId, projectId }),
            action: actionName,
            intentHash,
            id: command.operationId,
          });
          if (
            retained.phase !== "dispatching" ||
            contentHash(retained.command) !== contentHash(command)
          )
            throw new HostedNeuronTrainingExecutionError(
              "neuron_training_review_required",
              "Recover the exact reviewed experiment operation before dispatch.",
            );
          const retainedAccount = ActivationExperimentAccountSchema.parse(
            z.object({ account: z.unknown() }).parse(retained.reviewedIntent).account,
          );
          if (contentHash(retainedAccount) !== contentHash({ teamId, actorId, apiOrigin }))
            throw new HostedNeuronTrainingExecutionError(
              "neuron_training_account_changed",
              "The retained experiment belongs to another original account.",
            );
          validateReviewedEvaluationCommand({
            action: actionName,
            id: command.operationId,
            actorId,
            teamId,
            projectId,
            intent: retained.reviewedIntent,
            command,
          });
          if (action === "prepare") return null;
          const original = NeuronTrainingExperimentControlIntentSchema.parse(
            retained.reviewedIntent,
          );
          return original.preparationOperationId === null ? original.execution : null;
        },
      }).perform(body);
    }
    if (action === "hosted_decision_publication") {
      const body = HostedDecisionPublicationEnvelopeSchema.parse(payload);
      const [teamId, actorId, access] = await Promise.all([
        deps.teamId(),
        deps.actorId(),
        deps.resolveAccess(),
      ]);
      const apiOrigin = new URL(access.apiBaseUrl).origin;
      return createHostedDecisionPublication({
        teamId,
        actorId,
        access,
        currentIdentity: async () => ({
          teamId: await deps.teamId(),
          actorId: await deps.actorId(),
          apiOrigin: (await deps.resolveAccess()).apiBaseUrl,
        }),
        assertRetained: async (command, intentHash, projectId) => {
          const retained = await deps.store.readPendingEvaluationOperation({
            scopeHash: contentHash({ actorId, apiOrigin, teamId, projectId }),
            action: "training-decision-result-save",
            intentHash,
            id: command.operationId,
          });
          if (
            retained.phase !== "dispatching" ||
            contentHash(retained.command) !== contentHash(command)
          )
            throw new HostedDecisionExecutionError(
              "decision_save_review_required",
              "Recover the original reviewed Model save before dispatch.",
            );
          const intent = DecisionModelSaveIntentSchema.parse(retained.reviewedIntent);
          if (contentHash(intent.account) !== contentHash({ teamId, actorId, apiOrigin }))
            throw new HostedDecisionExecutionError(
              "decision_save_account_changed",
              "Return to this Model save's original account.",
            );
          validateReviewedEvaluationCommand({
            action: "training-decision-result-save",
            id: command.operationId,
            actorId,
            teamId,
            projectId,
            intent: retained.reviewedIntent,
            command,
          });
        },
      }).perform(body);
    }
    if (action === "hosted_engram_publication") {
      const body = HostedEngramPublicationEnvelopeSchema.parse(payload);
      const [teamId, actorId, access] = await Promise.all([
        deps.teamId(),
        deps.actorId(),
        deps.resolveAccess(),
      ]);
      const apiOrigin = new URL(access.apiBaseUrl).origin;
      return createHostedEngramPublication({
        teamId,
        actorId,
        access,
        currentIdentity: async () => ({
          teamId: await deps.teamId(),
          actorId: await deps.actorId(),
          apiOrigin: (await deps.resolveAccess()).apiBaseUrl,
        }),
        assertRetained: async (command, intentHash, projectId) => {
          const retained = await deps.store.readPendingEvaluationOperation({
            scopeHash: contentHash({ actorId, apiOrigin, teamId, projectId }),
            action: "training-engram-result-save",
            intentHash,
            id: command.operationId,
          });
          if (
            retained.phase !== "dispatching" ||
            contentHash(retained.command) !== contentHash(command)
          )
            throw new HostedEngramExecutionError(
              "engram_save_review_required",
              "Recover the original reviewed Model save before dispatch.",
            );
          const intent = EngramModelSaveIntentSchema.parse(retained.reviewedIntent);
          if (contentHash(intent.account) !== contentHash({ teamId, actorId, apiOrigin }))
            throw new HostedEngramExecutionError(
              "engram_save_account_changed",
              "Return to this Model save's original account.",
            );
          validateReviewedEvaluationCommand({
            action: "training-engram-result-save",
            id: command.operationId,
            actorId,
            teamId,
            projectId,
            intent: retained.reviewedIntent,
            command,
          });
        },
      }).perform(body);
    }
    if (action === "hosted_steering_publication") {
      const body = HostedSteeringPublicationEnvelopeSchema.parse(payload);
      const [teamId, actorId, access] = await Promise.all([
        deps.teamId(),
        deps.actorId(),
        deps.resolveAccess(),
      ]);
      const apiOrigin = new URL(access.apiBaseUrl).origin;
      return createHostedSteeringPublication({
        teamId,
        actorId,
        access,
        currentIdentity: async () => ({
          teamId: await deps.teamId(),
          actorId: await deps.actorId(),
          apiOrigin: (await deps.resolveAccess()).apiBaseUrl,
        }),
        assertRetained: async (command, intentHash, projectId) => {
          const retained = await deps.store.readPendingEvaluationOperation({
            scopeHash: contentHash({ actorId, apiOrigin, teamId, projectId }),
            action: "training-steering-result-save",
            intentHash,
            id: command.operationId,
          });
          if (
            retained.phase !== "dispatching" ||
            contentHash(retained.command) !== contentHash(command)
          )
            throw new HostedModificationExecutionError(
              "steering_save_review_required",
              "Recover the original reviewed Model save before dispatch.",
            );
          const intent = SteeringModelSaveIntentSchema.parse(retained.reviewedIntent);
          if (contentHash(intent.account) !== contentHash({ teamId, actorId, apiOrigin }))
            throw new HostedModificationExecutionError(
              "steering_save_account_changed",
              "Return to this Model save's original account.",
            );
          validateReviewedEvaluationCommand({
            action: "training-steering-result-save",
            id: command.operationId,
            actorId,
            teamId,
            projectId,
            intent: retained.reviewedIntent,
            command,
          });
        },
      }).perform(body);
    }
    if (action === "hosted_decision_execution") {
      const body = HostedDecisionExecutionEnvelopeSchema.parse(payload);
      const [teamId, actorId, access] = await Promise.all([
        deps.teamId(),
        deps.actorId(),
        deps.resolveAccess(),
      ]);
      const apiOrigin = new URL(access.apiBaseUrl).origin;
      return createHostedDecisionExecutions({
        teamId,
        actorId,
        access,
        currentIdentity: async () => ({
          teamId: await deps.teamId(),
          actorId: await deps.actorId(),
          apiOrigin: (await deps.resolveAccess()).apiBaseUrl,
        }),
        assertRetained: async ({ action, command, intentHash, projectId }) => {
          const actionName = `training:${action}-decision`;
          const retained = await deps.store.readPendingEvaluationOperation({
            scopeHash: contentHash({ actorId, apiOrigin, teamId, projectId }),
            action: actionName,
            intentHash,
            id: command.operationId,
          });
          if (
            retained.phase !== "dispatching" ||
            contentHash(retained.command) !== contentHash(command)
          )
            throw new HostedDecisionExecutionError(
              "decision_review_required",
              "Recover the exact reviewed experiment operation before dispatch.",
            );
          const retainedAccount = ActivationExperimentAccountSchema.parse(
            z.object({ account: z.unknown() }).parse(retained.reviewedIntent).account,
          );
          if (contentHash(retainedAccount) !== contentHash({ teamId, actorId, apiOrigin }))
            throw new HostedDecisionExecutionError(
              "decision_account_changed",
              "The retained experiment belongs to another original account.",
            );
          validateReviewedEvaluationCommand({
            action: actionName,
            id: command.operationId,
            actorId,
            teamId,
            projectId,
            intent: retained.reviewedIntent,
            command,
          });
          if (action === "prepare") return null;
          const original = DecisionExperimentControlIntentSchema.parse(retained.reviewedIntent);
          return original.preparationOperationId === null ? original.execution : null;
        },
      }).perform(body);
    }
    if (action === "hosted_engram_execution") {
      const body = HostedEngramExecutionEnvelopeSchema.parse(payload);
      const [teamId, actorId, access] = await Promise.all([
        deps.teamId(),
        deps.actorId(),
        deps.resolveAccess(),
      ]);
      const apiOrigin = new URL(access.apiBaseUrl).origin;
      return createHostedEngramExecutions({
        teamId,
        actorId,
        access,
        currentIdentity: async () => ({
          teamId: await deps.teamId(),
          actorId: await deps.actorId(),
          apiOrigin: (await deps.resolveAccess()).apiBaseUrl,
        }),
        assertRetained: async ({ action, command, intentHash, projectId }) => {
          const actionName = `training:${action}-engram`;
          const retained = await deps.store.readPendingEvaluationOperation({
            scopeHash: contentHash({ actorId, apiOrigin, teamId, projectId }),
            action: actionName,
            intentHash,
            id: command.operationId,
          });
          if (
            retained.phase !== "dispatching" ||
            contentHash(retained.command) !== contentHash(command)
          )
            throw new HostedEngramExecutionError(
              "engram_review_required",
              "Recover the exact reviewed experiment operation before dispatch.",
            );
          const retainedAccount = ActivationExperimentAccountSchema.parse(
            z.object({ account: z.unknown() }).parse(retained.reviewedIntent).account,
          );
          if (contentHash(retainedAccount) !== contentHash({ teamId, actorId, apiOrigin }))
            throw new HostedEngramExecutionError(
              "engram_account_changed",
              "The retained experiment belongs to another original account.",
            );
          validateReviewedEvaluationCommand({
            action: actionName,
            id: command.operationId,
            actorId,
            teamId,
            projectId,
            intent: retained.reviewedIntent,
            command,
          });
          if (action === "prepare") return null;
          const original = EngramExperimentControlIntentSchema.parse(retained.reviewedIntent);
          return original.preparationOperationId === null ? original.execution : null;
        },
      }).perform(body);
    }
    if (action === "hosted_modification_execution") {
      const body = HostedModificationExecutionEnvelopeSchema.parse(payload);
      const [teamId, actorId, access] = await Promise.all([
        deps.teamId(),
        deps.actorId(),
        deps.resolveAccess(),
      ]);
      const apiOrigin = new URL(access.apiBaseUrl).origin;
      return createHostedModificationExecutions({
        teamId,
        actorId,
        access,
        currentIdentity: async () => ({
          teamId: await deps.teamId(),
          actorId: await deps.actorId(),
          apiOrigin: (await deps.resolveAccess()).apiBaseUrl,
        }),
        assertRetained: async ({ action, command, intentHash, projectId }) => {
          const actionName = `training:${action}-modification`;
          const retained = await deps.store.readPendingEvaluationOperation({
            scopeHash: contentHash({ actorId, apiOrigin, teamId, projectId }),
            action: actionName,
            intentHash,
            id: command.operationId,
          });
          if (
            retained.phase !== "dispatching" ||
            contentHash(retained.command) !== contentHash(command)
          )
            throw new HostedModificationExecutionError(
              "modification_review_required",
              "Recover the exact reviewed experiment operation before dispatch.",
            );
          const retainedAccount = ActivationExperimentAccountSchema.parse(
            z.object({ account: z.unknown() }).parse(retained.reviewedIntent).account,
          );
          if (contentHash(retainedAccount) !== contentHash({ teamId, actorId, apiOrigin }))
            throw new HostedModificationExecutionError(
              "modification_account_changed",
              "The retained experiment belongs to another original account.",
            );
          validateReviewedEvaluationCommand({
            action: actionName,
            id: command.operationId,
            actorId,
            teamId,
            projectId,
            intent: retained.reviewedIntent,
            command,
          });
          if (action === "prepare") return null;
          const original = ActivationExperimentControlIntentSchema.parse(retained.reviewedIntent);
          return original.preparationOperationId === null ? original.execution : null;
        },
      }).perform(body);
    }
    if (action === "hosted_candidate_evaluation") {
      const body = z
        .object({
          teamId: z.string().min(1),
          id: z.string().min(1).max(200).optional(),
          action: z.enum(["options", "save", "read", "prepare", "run", "cancel"]),
          query: z
            .object({ afterId: z.string().optional(), projectId: z.string().optional() })
            .strict()
            .optional(),
          command: z.unknown().optional(),
        })
        .strict()
        .parse(payload);
      const [teamId, actorId, access] = await Promise.all([
        deps.teamId(),
        deps.actorId(),
        deps.resolveAccess(),
      ]);
      if (body.teamId !== teamId)
        throw new Error("The active workspace changed. Reopen trained-version evaluation.");
      const client = createHostedCandidateEvaluations({
        teamId,
        actorId,
        access,
        currentIdentity: async () => ({
          teamId: await deps.teamId(),
          actorId: await deps.actorId(),
        }),
      });
      if (body.action === "options") return client.options(body.query ?? {});
      if (body.action === "save")
        return client.save(body.command as Parameters<typeof client.save>[0]);
      const id = z.string().min(1).parse(body.id);
      return body.action === "read"
        ? client.read(id)
        : client.control(id, body.action, body.command);
    }
    if (action === "hosted_training_policy") {
      const body = z
        .object({
          teamId: z.string().min(1),
          id: z.string().min(1).max(200),
          afterId: z.string().min(1).max(200).nullable().optional(),
          command: z.unknown().optional(),
        })
        .strict()
        .parse(payload);
      const [teamId, actorId, access] = await Promise.all([
        deps.teamId(),
        deps.actorId(),
        deps.resolveAccess(),
      ]);
      if (body.teamId !== teamId)
        throw new Error("The active workspace changed. Reopen this policy.");
      const setup = createHostedTrainingSetup({
        teamId,
        actorId,
        access,
        currentIdentity: async () => ({
          teamId: await deps.teamId(),
          actorId: await deps.actorId(),
        }),
      });
      if (body.command !== undefined) {
        if (z.object({ id: z.string() }).passthrough().parse(body.command).id !== body.id)
          throw new Error("This command belongs to another policy.");
        return setup.policyControl(body.command);
      }
      return setup.policyRead(body.id, body.afterId ?? undefined);
    }
    if (action === "hosted_training_setup") {
      const body = z
        .object({
          teamId: z.string().min(1),
          draftInputs: z.boolean().optional(),
          cursor: z.string().min(1).max(500).nullable().optional(),
          configurationId: z.string().min(1).max(200).nullable().optional(),
          projectId: z.string().min(1).max(200).nullable().optional(),
          action: HostedTrainingSetupActionSchema.optional(),
          command: z.unknown().optional(),
        })
        .strict()
        .parse(payload);
      const [teamId, actorId, access] = await Promise.all([
        deps.teamId(),
        deps.actorId(),
        deps.resolveAccess(),
      ]);
      if (body.teamId !== teamId)
        throw new Error("The active workspace changed. Reopen training setup.");
      const setup = createHostedTrainingSetup({
        teamId,
        actorId,
        access,
        currentIdentity: async () => ({
          teamId: await deps.teamId(),
          actorId: await deps.actorId(),
          apiOrigin: (await deps.resolveAccess()).apiBaseUrl,
        }),
      });
      if (body.action) return setup.perform(body.action, body.command);
      if (body.draftInputs)
        return setup.draftInputs({
          projectId: body.projectId ?? null,
          ...(body.cursor ? { cursor: body.cursor } : {}),
        });
      return setup.catalog({
        configurationId: z.string().min(1).parse(body.configurationId),
        projectId: body.projectId ?? null,
      });
    }
    if (action === "experiment_training_handoff") {
      const body = z
        .object({
          teamId: z.string().min(1),
          executionId: z.string().min(1).max(200),
          passId: z.string().min(1).max(200).nullable(),
        })
        .strict()
        .parse(payload);
      const [teamId, actorId, access] = await Promise.all([
        deps.teamId(),
        deps.actorId(),
        deps.resolveAccess(),
      ]);
      if (body.teamId !== teamId)
        throw new Error("The active workspace changed. Reload this result.");
      return createHostedExperimentTrainingHandoff({
        teamId,
        actorId,
        access,
        currentIdentity: async () => ({
          teamId: await deps.teamId(),
          actorId: await deps.actorId(),
          apiOrigin: (await deps.resolveAccess()).apiBaseUrl,
        }),
      }).read(body.executionId, body.passId);
    }
    if (action === "hosted_decision_score") {
      const body = HostedDecisionScoringEnvelopeSchema.parse(payload);
      const [teamId, actorId, access] = await Promise.all([
        deps.teamId(),
        deps.actorId(),
        deps.resolveAccess(),
      ]);
      const apiOrigin = new URL(access.apiBaseUrl).origin;
      return createHostedDecisionScoring({
        teamId,
        actorId,
        access,
        currentIdentity: async () => ({
          teamId: await deps.teamId(),
          actorId: await deps.actorId(),
          apiOrigin: (await deps.resolveAccess()).apiBaseUrl,
        }),
        assertRetained: async (command, intentHash, projectId) => {
          const retained = await deps.store.readPendingEvaluationOperation({
            scopeHash: contentHash({ actorId, apiOrigin, teamId, projectId }),
            action: "training-decision-score",
            intentHash,
            id: command.request.requestId,
          });
          if (
            retained.phase !== "dispatching" ||
            contentHash(retained.command) !== contentHash(command)
          )
            throw new HostedDecisionExecutionError(
              "decision_score_review_required",
              "Recover the original reviewed typed score before dispatch.",
            );
          const intent = DecisionModelScoreIntentSchema.parse(retained.reviewedIntent);
          if (contentHash(intent.account) !== contentHash({ teamId, actorId, apiOrigin }))
            throw new HostedDecisionExecutionError(
              "decision_score_account_changed",
              "Return to this score's original account.",
            );
          validateReviewedEvaluationCommand({
            action: "training-decision-score",
            id: command.request.requestId,
            actorId,
            teamId,
            projectId,
            intent: retained.reviewedIntent,
            command,
          });
        },
      }).perform(body);
    }
    if (action === "execution_activity") return activity(payload);
    if (action !== "human_review")
      return trainingDetailRequest(action, payload, requestUrl, signal);
    const location = requestUrl?.searchParams.get("location") ?? "hosted";
    if (location === "local") {
      if (HumanRevokeLocalPublicationSchema.safeParse(payload).success)
        return revokeLocalHumanPublication({ ...deps, hosted }, payload, signal);
      if (HumanExportLocalRequestSchema.safeParse(payload).success)
        return exportLocalHumanEvidence(deps, payload);
      if (HumanShareLocalRequestSchema.safeParse(payload).success)
        return shareLocalHumanEvidence({ ...deps, hosted }, payload, signal);
      if (HumanLocalPublicationsReadSchema.safeParse(payload).success)
        return readLocalHumanPublicationRefs(deps, payload);
      return local.request(payload);
    }
    if (location === "hosted") return hosted.request(payload, signal);
    throw new Error("Choose a valid review execution location.");
  };
}
