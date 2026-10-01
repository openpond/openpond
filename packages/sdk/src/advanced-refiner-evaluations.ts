import {EvaluationCoordinationTransport,type EvaluationCoordinationAccess} from "./evaluation-coordination-http.js";
import { z } from "zod";
import { ExperimentImprovementOptionsSchema } from "./experiment-improvement-contracts.js";
import { ChatModelRefSchema } from "@openpond/harness/models";
import { ImmutableReleaseRefSchema, contentHash } from "@openpond/harness";
import {
  ProfileExternalDatasetBindingSchema,
  verifyProfileExternalDatasetBinding,
} from "@openpond/evals";
const Id = z.string().trim().min(1).max(240),
  Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const AdvancedRefinerEvaluationPinSchema = z
  .object({
    schemaVersion: z.literal("openpond.advancedRefinerEvaluation.v1"),
    operationId: Id,
    actorId: Id,
    teamId: Id,
    projectId: Id.nullable(),
    mode: z.enum(["review_quality", "downstream_adaptation"]),
    profileRef: z
      .object({
        source: z.enum(["local", "github", "openpond_git"]),
        repositoryId: Id,
        profileId: Id,
      })
      .strict(),
    sourceRevision: z.string().min(1).max(500),
    baselineRelease: ImmutableReleaseRefSchema,
    refinerRelease: ImmutableReleaseRefSchema,
    evidence: ImmutableReleaseRefSchema,
    externalDatasetBinding: ProfileExternalDatasetBindingSchema,
    adaptationDatasetBinding: ProfileExternalDatasetBindingSchema,
    privateClosureHash: Hash,
    adaptationTaskIds: z.array(Id).min(1).max(10000),
    holdoutTaskIds: z.array(Id).min(1).max(10000),
    adaptationSplit: z.enum(["train", "validation", "test", "frozen_eval"]),
    holdoutSplit: z.enum(["train", "validation", "test", "frozen_eval"]),
    environmentPolicy: z.discriminatedUnion("kind", [
      z
        .object({ kind: z.literal("resettable"), environmentHash: Hash })
        .strict(),
      z
        .object({
          kind: z.literal("frozen_observations"),
          environmentHash: Hash,
        })
        .strict(),
    ]),
    maximumCostUsd: z.number().finite().positive().max(10000),
    maximumDurationMs: z.number().int().min(1000).max(86400000),
    maximumModelSteps: z.number().int().min(1).max(1000),
    contentHash: Hash,
  })
  .strict();
export type AdvancedRefinerEvaluationPin = z.infer<
  typeof AdvancedRefinerEvaluationPinSchema
>;
export function verifyAdvancedRefinerEvaluationPin(raw: unknown) {
  const value = AdvancedRefinerEvaluationPinSchema.parse(raw),
    { contentHash: hash, ...body } = value;
  if (contentHash(body) !== hash)
    throw new Error("Advanced Refiner evaluation admission changed.");
  const binding = verifyProfileExternalDatasetBinding(
    value.externalDatasetBinding,
  );
  if (
    binding.profileId !== value.profileRef.profileId ||
    binding.protectedProfileClosureHash !== value.privateClosureHash
  )
    throw new Error(
      "Advanced evaluation changed its Profile or protected evaluator closure.",
    );
  if (
    value.adaptationSplit === value.holdoutSplit ||
    new Set([...value.adaptationTaskIds, ...value.holdoutTaskIds]).size !==
      value.adaptationTaskIds.length + value.holdoutTaskIds.length
  )
    throw new Error(
      "Adaptation and private holdout must be disjoint ordered cases.",
    );
  const adaptation = verifyProfileExternalDatasetBinding(
    value.adaptationDatasetBinding,
  );
  if (
    adaptation.profileId !== binding.profileId ||
    adaptation.packageHash !== binding.packageHash ||
    contentHash(adaptation.dataset) !== contentHash(binding.dataset) ||
    contentHash(adaptation.target) !== contentHash(binding.target) ||
    adaptation.protectedProfileClosureHash !==
      binding.protectedProfileClosureHash
  )
    throw new Error(
      "This native advanced adapter needs separate adaptation and holdout recipes from the same exact released package and target.",
    );
  if (
    adaptation.split !== value.adaptationSplit ||
    binding.split !== value.holdoutSplit
  )
    throw new Error(
      "Advanced split policies differ from their exact admitted recipes.",
    );
  const population = new Set(binding.population.map((item) => item.taskId));
  const adapted = new Set(adaptation.population.map((item) => item.taskId));
  if (
    value.holdoutTaskIds.some((id) => !population.has(id)) ||
    value.adaptationTaskIds.some((id) => !adapted.has(id))
  )
    throw new Error(
      "Advanced evaluation selected cases outside its exact Dataset recipe.",
    );
  return value;
}
export function sealAdvancedRefinerEvaluationPin(
  body: Omit<AdvancedRefinerEvaluationPin, "contentHash">,
) {
  return verifyAdvancedRefinerEvaluationPin({
    ...body,
    contentHash: contentHash(body),
  });
}
export const AdvancedRefinerEvaluationStartSchema = z
  .object({
    pin: AdvancedRefinerEvaluationPinSchema,
    modelId: Id,
    profileId: Id,
    model: ChatModelRefSchema,
    seed: z.number().int(),
    reasoningEffort: z
      .enum(["none", "off", "low", "medium", "high", "xhigh", "max"])
      .nullable(),
  })
  .strict();
export const AdvancedRefinerEvaluationCommandSchema = z.discriminatedUnion(
  "operation",
  [
    z
      .object({
        operation: z.literal("start"),
        request: AdvancedRefinerEvaluationStartSchema,
      })
      .strict(),
    z
      .object({ operation: z.enum(["read", "cancel", "resume"]), id: Id })
      .strict(),
    z.object({ operation: z.literal("list") }).strict(),
  ],
);
export const AdvancedRefinerReviewCaseReceiptSchema = z
  .object({
    taskId: Id,
    sourceCaseHash: Hash,
    reviewSessionId: Id,
    reviewTurnId: Id,
    inputHarness: ImmutableReleaseRefSchema,
    trigger: ImmutableReleaseRefSchema,
    decision: z.enum(["no_action", "route_deterministically", "queue_refiner"]),
    outcome: ImmutableReleaseRefSchema.nullable(),
    proposal: ImmutableReleaseRefSchema.nullable(),
    validations: z.array(ImmutableReleaseRefSchema).max(100),
    grade: z
      .object({
        id: Id,
        contentHash: Hash,
        score: z.number().min(0).max(1).nullable(),
        passed: z.boolean(),
        failureClass: z.string().nullable(),
      })
      .strict(),
    resetComplete: z.boolean(),
  })
  .strict();
export const AdvancedRefinerReviewReceiptSchema = z
  .object({
    schemaVersion: z.literal("openpond.advancedRefinerReviewReceipt.v1"),
    id: Id,
    runId: Id,
    pinHash: Hash,
    ownerActorId: Id,
    teamId: Id,
    privateClosureHash: Hash,
    refinerRelease: ImmutableReleaseRefSchema,
    cases: z.array(AdvancedRefinerReviewCaseReceiptSchema).min(1).max(10000),
    reviewScore: z.number().min(0).max(1).nullable(),
    completedCases: z.number().int().nonnegative(),
    noActionCases: z.number().int().nonnegative(),
    routedCases: z.number().int().nonnegative(),
    proposalCases: z.number().int().nonnegative(),
    costUsd: z.number().finite().nonnegative().nullable(),
    cleanupComplete: z.boolean(),
    createdAt: z.string().datetime(),
    contentHash: Hash,
  })
  .strict();
export type AdvancedRefinerReviewReceipt = z.infer<
  typeof AdvancedRefinerReviewReceiptSchema
>;
export function sealAdvancedRefinerReviewReceipt(
  body: Omit<AdvancedRefinerReviewReceipt, "contentHash">,
) {
  return AdvancedRefinerReviewReceiptSchema.parse({
    ...body,
    contentHash: contentHash(body),
  });
}

const AdvancedProfile =
  ExperimentImprovementOptionsSchema.shape.profiles.element;
export const AdvancedRefinerEvaluationOptionsSchema =
  ExperimentImprovementOptionsSchema.extend({
    profiles: z.array(
      AdvancedProfile.extend({
        components: z.array(
          AdvancedProfile.shape.components.element.extend({
            adaptationSplits: z.array(
              z.object({
                split: z.enum(["train", "validation", "test", "frozen_eval"]),
                taskIds: z.array(Id),
              }),
            ),
            environmentHash: Hash,
            resettable: z.boolean(),
            reviewQuality: z.boolean(),
          }),
        ),
      }),
    ),
    refinerReleases: z.array(ImmutableReleaseRefSchema),
    activeRefiner: ImmutableReleaseRefSchema.nullable(),
    models: z.array(z.object({ id: Id, profileId: Id, name: z.string(), location:z.enum(["local","hosted"]) })),
  });
export const AdvancedRefinerEvaluationPrepareSchema = z
  .object({
    operation: z.literal("prepare"),
    evidence: ImmutableReleaseRefSchema,
    profileOptionId: Id,
    componentLabel: Id,
    mode: z.enum(["review_quality", "downstream_adaptation"]),
    adaptationSplit: z.enum(["train", "validation", "test", "frozen_eval"]),
    operationId: Id,
    refinerRelease: ImmutableReleaseRefSchema,
    maximumCostUsd: z.number().positive(),
    maximumDurationMs: z.number().int().positive(),
    maximumModelSteps: z.number().int().positive(),
  })
  .strict();
export const AdvancedRefinerEvaluationSetupCommandSchema = z.union([
  AdvancedRefinerEvaluationCommandSchema,
  AdvancedRefinerEvaluationPrepareSchema,
  z
    .object({
      operation: z.literal("options"),
      evidence: ImmutableReleaseRefSchema,
    })
    .strict(),
]);
export type AdvancedRefinerEvaluationOptions = z.infer<
  typeof AdvancedRefinerEvaluationOptionsSchema
>;

export const AdvancedRefinerEvaluationAccountingSchema = z
  .object({
    modelRequests: z.number().int().nonnegative(),
    knownSpendUsd: z.number().nonnegative(),
    totalSpendUsd: z.number().nonnegative().nullable(),
    heldUsd: z.number().nonnegative(),
    uncertainRequests: z.number().int().nonnegative(),
  })
  .strict();

/** The owner's canonical ModelRun remains intact in readback. This boundary
 * validates its retained advanced pin rather than manufacturing results. */
export class OpenPondAdvancedRefinerEvaluationClient {
  private readonly transport:EvaluationCoordinationTransport;
  constructor(access:EvaluationCoordinationAccess){this.transport=new EvaluationCoordinationTransport(access);}
  async command(raw:z.input<typeof AdvancedRefinerEvaluationSetupCommandSchema>,signal?:AbortSignal){
    const request=AdvancedRefinerEvaluationSetupCommandSchema.parse(raw),access=this.transport.access;
    const assertPin=(raw:unknown)=>{const pin=verifyAdvancedRefinerEvaluationPin(raw);if(pin.actorId!==access.actorId||pin.teamId!==access.teamId||pin.projectId!==access.projectId)throw new Error("The advanced pin belongs to another evaluation owner.");return pin;};
    if(request.operation==="start")assertPin(request.request.pin);
    const value=await this.transport.post("advanced-refiner-evaluations",request,signal);
    if(request.operation==="options"){const result=AdvancedRefinerEvaluationOptionsSchema.parse(value);if(result.teamId!==access.teamId||contentHash(result.evidence)!==contentHash(request.evidence))throw new Error("Advanced options changed their reviewed evidence.");return result;}
    if(request.operation==="prepare"){const result=z.object({pin:AdvancedRefinerEvaluationPinSchema}).strict().parse(value);const pin=assertPin(result.pin);if(pin.operationId!==request.operationId||contentHash(pin.profileRef)!==request.profileOptionId||contentHash(pin.evidence)!==contentHash(request.evidence)||pin.mode!==request.mode||contentHash(pin.refinerRelease)!==contentHash(request.refinerRelease)||pin.adaptationSplit!==request.adaptationSplit||pin.maximumCostUsd!==request.maximumCostUsd||pin.maximumDurationMs!==request.maximumDurationMs||pin.maximumModelSteps!==request.maximumModelSteps)throw new Error("Advanced preparation changed its reviewed command.");return {pin};}
    if(request.operation==="list")return z.object({items:z.array(z.object({id:Id,status:z.enum(["prepared","running","succeeded","failed","cancelled"]),mode:z.enum(["review_quality","downstream_adaptation"]),startedAt:z.string().datetime().nullable(),completedAt:z.string().datetime().nullable(),failure:z.string().nullable()}).strict()).max(10000)}).strict().parse(value);
    if(request.operation==="cancel"){const result=z.object({id:Id,status:z.enum(["prepared","running","succeeded","failed","cancelled"])}).strict().parse(value);if(result.id!==request.id)throw new Error("Advanced cancellation returned another Run.");return result;}
    const result=z.object({schemaVersion:z.literal("openpond.modelRun.v1"),id:Id,kind:z.literal("evaluation"),modelId:Id,profileId:Id,evaluation:z.object({benchmarkId:z.literal("harness-refiner"),advancedEvaluation:AdvancedRefinerEvaluationPinSchema}).passthrough()}).passthrough().parse(value);
    const pin=assertPin(result.evaluation.advancedEvaluation);
    if(request.operation==="start"?(pin.contentHash!==request.request.pin.contentHash||result.modelId!==request.request.modelId||result.profileId!==request.request.profileId):result.id!==request.id)throw new Error("The advanced Run differs from its exact retained request.");
    return result;
  }
}
