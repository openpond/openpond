import {
  createAdvancedReviewCheckpoints,
  type ReviewCheckpoint,
} from "./advanced-refiner-review-checkpoint.js";
import { event } from "../utils.js";
import { contentHash } from "@openpond/harness";
import {
  ModelRunSchema,
  TurnSchema,
  TaskAttemptResultSchema,
  type ModelRun,
  type Session,
} from "@openpond/contracts";
import {
  sealAdvancedRefinerReviewReceipt,
  type AdvancedRefinerReviewReceipt,
} from "openpond-sdk/advanced-refiner-evaluations";
import { forkLocalHarnessWorkspaceFromRelease } from "../harness/local-harness-workspace-service.js";
import { ensureLocalHarnessRunOverlay } from "../harness/local-harness-run-overlay.js";
import { recordLocalHarnessImprovementBoundary } from "../harness/local-harness-improvement-observer.js";
import { runLocalHarnessRefinerWorker } from "../harness/local-harness-refiner-worker.js";
import { inspectRefinerProfile } from "../refiner/refiner-profile-service.js";
import type { createHarnessRefinerBenchmarkService } from "./harness-refiner-benchmark-service.js";
import type { createAdvancedRefinerEvaluationSource } from "./advanced-refiner-evaluation-source.js";
import type { createAdvancedRefinerPaidBoundary } from "./advanced-refiner-paid-boundary.js";

/** Each actual source case receives a new isolated review state. Scoring uses
 * only the declared review-output contract; foreground answers are never used
 * as reference labels for a Refiner decision. */
export function createAdvancedRefinerReviewQuality(deps: {
  source: {
    read(pin:Parameters<ReturnType<typeof createAdvancedRefinerEvaluationSource>["read"]>[0]):Promise<{packageValue:import("openpond-sdk/taskset-packages").TasksetPackage;authorize():Promise<void>}>;
    evidence:ReturnType<typeof createAdvancedRefinerEvaluationSource>["evidence"];
    reviewContext(pin:Parameters<ReturnType<typeof createAdvancedRefinerEvaluationSource>["reviewContext"]>[0],taskId:string):Promise<Omit<Awaited<ReturnType<ReturnType<typeof createAdvancedRefinerEvaluationSource>["reviewContext"]>>,"case">&{case:{output:string|null}}>;
  };
  boundary: ReturnType<typeof createAdvancedRefinerPaidBoundary>;
  benchmark: Parameters<typeof createHarnessRefinerBenchmarkService>[0];
  createSession(raw: unknown): Promise<Session>;
}) {
  const checkpoints = createAdvancedReviewCheckpoints(deps.benchmark.storeDir);
  return async (context: {
    modelRun: ModelRun;
    signal: AbortSignal;
  }): Promise<ModelRun> => {
    const job = context.modelRun,
      pin =
        job.evaluation?.benchmarkId === "harness-refiner"
          ? job.evaluation.advancedEvaluation
          : undefined;
    if (!pin || pin.mode !== "review_quality")
      throw new Error("Review-quality admission is unavailable.");
    const source = await deps.source.read(pin),
      taskset = await deps.benchmark.store.getTaskset(job.taskset.id);
    if (!taskset) throw new Error("The exact review Taskset is unavailable.");
    const declaration = source.packageValue.taskset.metadata
      .advancedRefinerReview as
      | { outputConvention?: unknown; contextEvidence?: unknown }
      | undefined;
    if (
      declaration?.outputConvention !== "openpond.refinerReviewOutput.v1" ||
      contentHash(declaration.contextEvidence) !== contentHash(pin.evidence)
    )
      throw new Error(
        "Publish a review-quality Dataset with independently grounded labels and the exact retained context-evidence binding before starting this target.",
      );
    const evidence = await deps.source.evidence(pin);
    const refiner = (
      await inspectRefinerProfile(deps.benchmark.storeDir)
    ).releases.find(
      (item) =>
        item.id === pin.refinerRelease.id &&
        item.contentHash === pin.refinerRelease.contentHash,
    );
    if (!refiner)
      throw new Error("The admitted Refiner release is unavailable.");
    const cases: AdvancedRefinerReviewReceipt["cases"] = [];
    for (const taskId of pin.holdoutTaskIds) {
      context.signal.throwIfAborted();
      await source.authorize();
      const task = taskset.tasks.find((task) => task.id === taskId),
        original = evidence.result.cases.find(
          (item) => item.identity.caseId === taskId,
        );
      if (!task || !original || original.status !== "completed")
        throw new Error("The exact independent review context is unavailable.");
      let retained = await checkpoints.read(job.id, taskId, pin);
      if (retained && retained.sourceCaseHash !== contentHash(original))
        throw new Error("The retained independent review context changed.");
      if (retained?.receipt && retained.cleanupComplete) {
        cases.push(retained.receipt);
        continue;
      }
      if (
        retained?.cleanupComplete &&
        !retained.result &&
        retained.trigger.decision === "queue_refiner"
      )
        throw new Error(
          "This interrupted Refiner case cleaned its overlay before receiving a settled outcome; reconcile the retained paid request before resuming.",
        );
      const actualContext = await deps.source.reviewContext(pin, taskId);
      const existingWorkspace = await deps.benchmark.store.getHarnessWorkspace(
        `review-${contentHash([job.id, taskId]).slice(0, 40)}`,
      );
      const existingRelease =
        existingWorkspace?.currentChannel.release &&
        (await deps.benchmark.store.getHarnessReleaseRecord(
          existingWorkspace.currentChannel.release.contentHash,
        ));
      const isolated =
        existingWorkspace && existingRelease
          ? { workspace: existingWorkspace, release: existingRelease }
          : await forkLocalHarnessWorkspaceFromRelease({
              store: deps.benchmark.store,
              storeDir: deps.benchmark.storeDir,
              id: `review-${contentHash([job.id, taskId]).slice(0, 40)}`,
              ownerId: `benchmark:${job.id}`,
              name: `Review ${taskId}`,
              sourceRelease: pin.baselineRelease,
            });
      let reviewSessionId: string | null = null,
        cleanupHandled = false;
      try {
        const shells = await deps.benchmark.store.sessionShells();
        const recoveredSession = retained
          ? await deps.benchmark.store.getSession(retained.sessionId)
          : shells.find(
              (row) =>
                row.metadata?.advancedRunId === job.id &&
                row.metadata?.advancedTaskId === taskId &&
                row.metadata?.actorId === pin.actorId &&
                row.cloudTeamId === pin.teamId,
            );
        const session =
          recoveredSession ??
          (await deps.createSession({
            experience: "work",
            provider: "openpond",
            modelRef: (
              job.evaluation as Extract<
                NonNullable<ModelRun["evaluation"]>,
                { benchmarkId: "harness-refiner" }
              >
            ).model,
            hiddenFromDefaultSidebar: true,
            openPondCommandAccessMode: "disabled",
            cwd: null,
            title: `Evaluate Refiner ${taskId}`,
            cloudTeamId: pin.teamId,
            metadata: {
              source: "advanced-refiner-evaluation",
              automatedTasksetWorkAttempt: true,
              advancedRunId: job.id,
              advancedTaskId: taskId,
              actorId: pin.actorId,
              sourceEvidence: pin.evidence,
              sourceCaseHash: contentHash(original),
            },
          }));
        reviewSessionId = session.id;
        const now = new Date().toISOString(),
          turnId = `review-turn-${contentHash([job.id, taskId]).slice(0, 40)}`,
          overlay = await ensureLocalHarnessRunOverlay({
            store: deps.benchmark.store,
            runId: session.id,
            workspace: isolated.workspace,
            harnessRelease: {
              id: isolated.release.harnessRelease.id,
              contentHash: isolated.release.harnessRelease.contentHash,
            },
            admittedAt: now,
          });
        const turn = TurnSchema.parse({
          id: turnId,
          sessionId: session.id,
          providerTurnId: null,
          modelRef: (
            job.evaluation as Extract<
              NonNullable<ModelRun["evaluation"]>,
              { benchmarkId: "harness-refiner" }
            >
          ).model,
          prompt: actualContext.turn.prompt,
          startedAt: now,
          completedAt: now,
          status: "completed",
          error: null,
          metadata: {
            source: "advanced-refiner-evaluation",
            automatedTasksetWorkAttempt: true,
            sourceCaseHash: contentHash(original),
          },
          createImproveRun: null,
          profileSnapshot: null,
          harnessSnapshot: {
            schemaVersion: "openpond.harnessTurnSnapshot.v1",
            workspaceId: isolated.workspace.id,
            workspaceRevision: isolated.workspace.revision,
            sourceRevision: isolated.workspace.sourceRevision,
            channelName: isolated.workspace.currentChannel.name,
            channelRevision: isolated.workspace.currentChannel.revision,
            harnessRelease: overlay.baseHarnessRelease,
            overlay: {
              id: overlay.id,
              revision: overlay.revision,
              contentHash: overlay.contentHash,
            },
          },
        });
        if (!retained) {
          if (!(await deps.benchmark.store.getTurn(turnId)))
            await deps.benchmark.store.insertTurn(turn);
          const copied =
            await deps.benchmark.store.runtimeEventsForTurn(turnId);
          for (const originalEvent of actualContext.events) {
            if (
              copied.some(
                (row) =>
                  (
                    row.data as
                      | { reviewContextOrigin?: { eventId: string } }
                      | undefined
                  )?.reviewContextOrigin?.eventId === originalEvent.id,
              )
            )
              continue;
            const {
              id: originalId,
              timestamp: originalTimestamp,
              sequence: originalSequence,
              ...body
            } = originalEvent;
            void originalTimestamp;
            void originalSequence;
            await deps.benchmark.store.appendRuntimeEvent(
              event({
                ...body,
                sessionId: session.id,
                turnId,
                appId: session.appId,
                data: {
                  ...(typeof body.data === "object" && body.data
                    ? body.data
                    : {}),
                  reviewContextOrigin: {
                    eventId: originalId,
                    eventHash: contentHash(originalEvent),
                    traceHash: actualContext.traceHash,
                    sourceEvidence: pin.evidence,
                  },
                },
              }),
            );
          }
          if (
            !copied.some(
              (row) =>
                row.name === "assistant.delta" &&
                (row.data as { sourceCaseHash?: string } | undefined)
                  ?.sourceCaseHash === contentHash(original),
            )
          )
            await deps.benchmark.store.appendRuntimeEvent(
              event({
                sessionId: session.id,
                turnId,
                name: "assistant.delta",
                source: "server",
                appId: session.appId,
                status: "completed",
                output: actualContext.case.output ?? undefined,
                data: {
                  sourceEvidence: pin.evidence,
                  sourceCaseHash: contentHash(original),
                },
              }),
            );
        }
        await deps.benchmark.store.setHarnessBackgroundReviewSettings({
          workspaceId: isolated.workspace.id,
          enabled: true,
          updatedAt: new Date().toISOString(),
        });
        const detection = retained
          ? { trigger: retained.trigger }
          : await recordLocalHarnessImprovementBoundary({
              store: deps.benchmark.store,
              session,
              turn,
              boundaryKind: "turn_completed",
            });
        if (!detection)
          throw new Error(
            "The actual context produced no retained trigger decision.",
          );
        const saveCheckpoint = async (patch: Partial<ReviewCheckpoint>) => {
          const body = retained
            ? (({ contentHash: _hash, ...rest }) => rest)(retained)
            : {
                runId: job.id,
                taskId,
                actorId: pin.actorId,
                teamId: pin.teamId,
                pinHash: pin.contentHash,
                sourceCaseHash: contentHash(original),
                sessionId: session.id,
                turnId,
                workspaceId: isolated.workspace.id,
                trigger: detection.trigger,
                result: null,
                receipt: null,
                cleanupComplete: false,
              };
          retained = await checkpoints.write({ ...body, ...patch });
        };
        if (!retained) await saveCheckpoint({});
        let result: Awaited<
          ReturnType<typeof runLocalHarnessRefinerWorker>
        > | null = retained?.result ?? null;
        let resetComplete = false;
        try {
          if (!result && detection.trigger.decision === "queue_refiner")
            result = await runLocalHarnessRefinerWorker({
              store: deps.benchmark.store,
              storeDir: deps.benchmark.storeDir,
              trigger: detection.trigger,
              loadActiveRefinerRelease: async () => refiner,
              signal: context.signal,
              stream: async function* (input) {
                yield* deps.benchmark.refinerStream({
                  ...input,
                  model: (
                    job.evaluation as Extract<
                      NonNullable<ModelRun["evaluation"]>,
                      { benchmarkId: "harness-refiner" }
                    >
                  ).model,
                  pricing: (
                    job.evaluation as Extract<
                      NonNullable<ModelRun["evaluation"]>,
                      { benchmarkId: "harness-refiner" }
                    >
                  ).upstreamModel.pricing!,
                  requestId: `review-refiner:${job.id}:${taskId}`,
                });
              },
            });
          await saveCheckpoint({ result });
          const output = {
            schemaVersion: "openpond.refinerReviewOutput.v1",
            decision: detection.trigger.decision,
            trigger: detection.trigger,
            outcome: result?.outcome ?? null,
            proposal: result?.proposal ?? null,
            validations: result?.validations ?? [],
            sourceContext: {
              evidence: pin.evidence,
              caseHash: contentHash(original),
            },
          };
          const attempt = TaskAttemptResultSchema.parse({
            schemaVersion: "openpond.taskAttempt.v1",
            id: `review-attempt-${contentHash([job.id, taskId]).slice(0, 40)}`,
            tasksetId: taskset.id,
            taskId,
            split: task.split,
            attempt: 0,
            modelRef: (
              job.evaluation as Extract<
                NonNullable<ModelRun["evaluation"]>,
                { benchmarkId: "harness-refiner" }
              >
            ).model,
            seed: (
              job.evaluation as Extract<
                NonNullable<ModelRun["evaluation"]>,
                { benchmarkId: "harness-refiner" }
              >
            ).seeds[0],
            output: { text: JSON.stringify(output), json: output },
            runtimeEventRefs: [],
            artifactRefs: [],
            privilegedOutcomeRef: null,
            infrastructureError: null,
            latencyMs: Date.now() - Date.parse(now),
            costUsd: null,
            startedAt: now,
            completedAt: new Date().toISOString(),
            metadata: {
              execution: "advanced_refiner_review",
              runId: job.id,
              sourceCaseHash: contentHash(original),
              refinerRelease: pin.refinerRelease,
            },
          });
          const grade = await deps.benchmark.evaluation.grade({
            tasksetId: taskset.id,
            taskId,
            attempt,
            hostedTokenPricing: (
              job.evaluation as Extract<
                NonNullable<ModelRun["evaluation"]>,
                { benchmarkId: "harness-refiner" }
              >
            ).upstreamModel.pricing,
          });
          const current = await deps.benchmark.store.getHarnessRunOverlay(
            session.id,
          );
          if (!current)
            throw new Error(
              "The actual isolated review overlay is unavailable.",
            );
          if (current.status !== "abandoned")
            await deps.benchmark.store.abandonHarnessRunOverlayAtomically({
              runId: session.id,
              expectedRevision: current.revision,
              updatedAt: new Date().toISOString(),
            });
          resetComplete = true;
          const caseReceipt: AdvancedRefinerReviewReceipt["cases"][number] = {
            taskId,
            sourceCaseHash: contentHash(original),
            reviewSessionId: session.id,
            reviewTurnId: turnId,
            inputHarness: overlay.baseHarnessRelease,
            trigger: {
              id: detection.trigger.id,
              contentHash: detection.trigger.contentHash,
            },
            decision: detection.trigger.decision,
            outcome: result
              ? {
                  id: result.outcome.id,
                  contentHash: result.outcome.contentHash,
                }
              : null,
            proposal: result?.proposal
              ? {
                  id: result.proposal.id,
                  contentHash: result.proposal.contentHash,
                }
              : null,
            validations: (result?.validations ?? []).map((row) => ({
              id: row.id,
              contentHash: row.contentHash,
            })),
            grade: {
              id: grade.id,
              contentHash: contentHash(grade),
              score: grade.score,
              passed: grade.passed,
              failureClass: grade.failureClass,
            },
            resetComplete,
          };
          await saveCheckpoint({ receipt: caseReceipt, cleanupComplete: true });
          cases.push(caseReceipt);
        } finally {
          await deps.benchmark.store.setHarnessBackgroundReviewSettings({
            workspaceId: isolated.workspace.id,
            enabled: false,
            updatedAt: new Date().toISOString(),
          });
          if (!resetComplete) {
            const current = await deps.benchmark.store.getHarnessRunOverlay(
              session.id,
            );
            if (current && current.status !== "abandoned")
              await deps.benchmark.store.abandonHarnessRunOverlayAtomically({
                runId: session.id,
                expectedRevision: current.revision,
                updatedAt: new Date().toISOString(),
              });
          }
          await saveCheckpoint({ cleanupComplete: true });
          cleanupHandled = true;
        }
      } finally {
        if (!cleanupHandled) {
          await deps.benchmark.store.setHarnessBackgroundReviewSettings({
            workspaceId: isolated.workspace.id,
            enabled: false,
            updatedAt: new Date().toISOString(),
          });
          if (reviewSessionId) {
            const current =
              await deps.benchmark.store.getHarnessRunOverlay(reviewSessionId);
            if (current && current.status !== "abandoned")
              await deps.benchmark.store.abandonHarnessRunOverlayAtomically({
                runId: reviewSessionId,
                expectedRevision: current.revision,
                updatedAt: new Date().toISOString(),
              });
          }
        }
      }
    }
    const calls = deps.boundary.read(job.id, pin) ?? [],
      costUsd = calls.some(
        (call) => call.state !== "completed" && call.state !== "not_dispatched",
      )
        ? null
        : calls.reduce((sum, call) => sum + Number(call.actual_spend ?? 0), 0),
      scores = cases
        .map((item) => item.grade.score)
        .filter((score): score is number => score !== null),
      stamp = new Date().toISOString();
    const receipt = sealAdvancedRefinerReviewReceipt({
      schemaVersion: "openpond.advancedRefinerReviewReceipt.v1",
      id: `review-receipt-${job.id}`,
      runId: job.id,
      pinHash: pin.contentHash,
      ownerActorId: pin.actorId,
      teamId: pin.teamId,
      privateClosureHash: pin.privateClosureHash,
      refinerRelease: pin.refinerRelease,
      cases,
      reviewScore:
        scores.length === cases.length
          ? scores.reduce((sum, score) => sum + score, 0) / scores.length
          : null,
      completedCases: scores.length,
      noActionCases: cases.filter((item) => item.decision === "no_action")
        .length,
      routedCases: cases.filter(
        (item) => item.decision === "route_deterministically",
      ).length,
      proposalCases: cases.filter((item) => item.proposal !== null).length,
      costUsd,
      cleanupComplete: cases.every((item) => item.resetComplete),
      createdAt: stamp,
    });
    return deps.benchmark.store.saveModelRun(
      ModelRunSchema.parse({
        ...job,
        status:
          receipt.reviewScore !== null &&
          receipt.cleanupComplete &&
          costUsd !== null
            ? "succeeded"
            : "failed",
        receipt,
        reward: null,
        failure:
          receipt.reviewScore === null
            ? "Review grade coverage is incomplete."
            : null,
        completedAt: stamp,
        updatedAt: stamp,
      }),
    );
  };
}
