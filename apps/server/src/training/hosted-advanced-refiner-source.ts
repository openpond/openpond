import path from "node:path";
import { z } from "zod";
import { contentHash } from "@openpond/harness";
import {
  SessionSchema,
  TurnSchema,
  RuntimeEventSchema,
  type HarnessWorkspace,
} from "@openpond/contracts";
import { verifyExperimentEvidence } from "@openpond/evals/experiments";
import {
  TasksetPackageSchema,
  validateTasksetPackage,
} from "openpond-sdk/taskset-packages";
import {
  verifyAdvancedRefinerEvaluationPin,
  type AdvancedRefinerEvaluationPin,
} from "openpond-sdk/advanced-refiner-evaluations";
import type { SqliteStore } from "../store/store.js";
import { compileLocalHarnessSource } from "../harness/local-harness-workspace-service.js";
import { compiledCandidateExecutableIdentity } from "../harness/experiment-candidate-equivalence.js";
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const HostedAdvancedReviewContextSchema = z
  .object({
    taskId: z.string().min(1),
    caseHash: Hash,
    session: SessionSchema,
    turn: TurnSchema,
    events: z.array(RuntimeEventSchema).max(10000),
    traceHash: Hash,
    output: z.string().nullable(),
  })
  .strict();
export const HostedAdvancedPrivateSourceSchema = z
  .object({
    packageValue: TasksetPackageSchema,
    contexts: z.array(HostedAdvancedReviewContextSchema).max(10000),
  })
  .strict();
/** The worker supplies these exact facts from current hosted Dataset/Run/turn
 * owners. Native publication or caller-supplied bytes are not host provenance. */
export async function createHostedAdvancedRefinerSource(deps: {
  store: SqliteStore;
  workspace: HarnessWorkspace;
  actor: { actorId: string; teamId: string };
  source: { repositoryId: string; profileId: string; sourceRevision: string };
  evidence: unknown;
  pin: AdvancedRefinerEvaluationPin;
  privateSource: unknown;
  authorize(): Promise<void>;
}) {
  const pin = verifyAdvancedRefinerEvaluationPin(deps.pin),
    privateSource = HostedAdvancedPrivateSourceSchema.parse(deps.privateSource),
    packageValue = validateTasksetPackage(privateSource.packageValue),
    evidence = verifyExperimentEvidence(
      z
        .object({ manifest: z.unknown(), result: z.unknown() })
        .parse(deps.evidence),
    );
  async function authorize() {
    await deps.authorize();
    if (
      pin.actorId !== deps.actor.actorId ||
      pin.teamId !== deps.actor.teamId ||
      pin.profileRef.source !== "openpond_git" ||
      pin.profileRef.repositoryId !== deps.source.repositoryId ||
      pin.profileRef.profileId !== deps.source.profileId ||
      pin.sourceRevision !== deps.source.sourceRevision
    )
      throw new Error("The actual hosted advanced source owner changed.");
  }
  await authorize();
  if (
    evidence.manifest.teamId !== pin.teamId ||
    evidence.result.status !== "completed" ||
    evidence.manifest.id !== pin.evidence.id ||
    evidence.result.contentHash !== pin.evidence.contentHash ||
    contentHash(evidence.manifest.dataset) !==
      contentHash(pin.externalDatasetBinding.dataset)
  )
    throw new Error("The exact completed hosted advanced evidence changed.");
  if (
    packageValue.contentHash !== pin.externalDatasetBinding.packageHash ||
    packageValue.contentHash !== pin.adaptationDatasetBinding.packageHash ||
    packageValue.environment.contentHash !==
      pin.environmentPolicy.environmentHash ||
    packageValue.environment.contract.networkPolicy !== "none"
  )
    throw new Error(
      "The hosted advanced environment/package is not the exact reviewed closed-network release.",
    );
  if (
    packageValue.taskset.tools.some(
      (tool) => tool.name === "web_search" || tool.name === "web_fetch",
    )
  )
    throw new Error(
      "Live external tools require their own qualified frozen-observation and budget owner.",
    );
  if (
    packageValue.verifierSet.graders.some(
      (grader) =>
        grader.kind === "human" ||
        (grader.kind === "model_judge" &&
          grader.calibrationStatus !== "passed"),
    )
  )
    throw new Error(
      "Advanced hosted evaluation needs executable, qualified independent graders.",
    );
  const adaptation = pin.adaptationTaskIds.map((id) =>
      packageValue.taskset.tasks.find((task) => task.id === id),
    ),
    holdout = pin.holdoutTaskIds.map((id) =>
      packageValue.taskset.tasks.find((task) => task.id === id),
    ),
    families = new Set(adaptation.map((task) => task?.clusterKey));
  if (
    adaptation.some((task) => !task || task.split !== pin.adaptationSplit) ||
    holdout.some(
      (task) =>
        !task ||
        task.split !== pin.holdoutSplit ||
        families.has(task.clusterKey),
    )
  )
    throw new Error(
      "Hosted adaptation/holdout membership or independent families changed.",
    );
  const baseline = await deps.store.getHarnessReleaseRecord(
    pin.baselineRelease.contentHash,
  );
  if (
    !baseline ||
    baseline.harnessRelease.id !== pin.baselineRelease.id ||
    deps.workspace.currentChannel.release?.contentHash !==
      pin.baselineRelease.contentHash
  )
    throw new Error("The exact hosted source baseline is unavailable.");
  const compiled = await compileLocalHarnessSource({
    workspaceId:
      typeof baseline.agentSnapshot.metadata.workspaceId === "string"
        ? baseline.agentSnapshot.metadata.workspaceId
        : baseline.workspaceId,
    sourceDir: path.join(baseline.bundlePath, "source"),
  });
  if (
    compiledCandidateExecutableIdentity(compiled).protectedClosureHash !==
    pin.privateClosureHash
  )
    throw new Error("The protected hosted Profile closure changed.");
  const result = { packageValue, authorize };
  return {
    read: async (raw: AdvancedRefinerEvaluationPin) => {
      if (
        verifyAdvancedRefinerEvaluationPin(raw).contentHash !== pin.contentHash
      )
        throw new Error("The actual hosted advanced admission changed.");
      await authorize();
      return result;
    },
    evidence: async () => {
      await authorize();
      return evidence;
    },
    authorize: async () => authorize(),
    reviewContext: async (
      _pin: AdvancedRefinerEvaluationPin,
      taskId: string,
    ) => {
      await authorize();
      const matches = privateSource.contexts.filter(
          (row) => row.taskId === taskId,
        ),
        original = evidence.result.cases.find(
          (row) => row.identity.caseId === taskId,
        );
      if (matches.length !== 1 || !original || original.status !== "completed")
        throw new Error(
          "The actual retained hosted review case is unavailable.",
        );
      const context = matches[0]!;
      if (
        context.caseHash !== contentHash(original) ||
        context.session.cloudTeamId !== pin.teamId ||
        context.turn.sessionId !== context.session.id ||
        context.turn.status === "in_progress" ||
        context.events.some(
          (event) =>
            event.sessionId !== context.session.id ||
            event.turnId !== context.turn.id,
        )
      )
        throw new Error(
          "The actual hosted review session/turn/trace binding changed.",
        );
      await authorize();
      return { ...context, case: { output: context.output } };
    },
  };
}
