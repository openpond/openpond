import {
  SubagentProgressSchema,
  SubagentReviewStateSchema,
  SubagentRunSchema,
  type RuntimeEvent,
  type Session,
  type SubagentProgress,
  type SubagentRef,
  type SubagentRoleSettings,
  type SubagentRun,
  type SubagentWorkerBrief,
  type Turn,
  type UsageRequestAttribution,
} from "@openpond/contracts";
import {
  subagentChildPrompt,
  subagentReviewPacketQuality,
  subagentReviewRoutingRecommendation,
} from "./policies-and-prompts.js";
import type { SubagentTurnPermissions } from "./continuation-runtime.js";
import { now, textFromUnknown } from "../../utils.js";
import {
  recordFromUnknown,
  stringFromRecord,
  uniqueNonEmptyStrings,
} from "../turns/value-utils.js";

const SUBAGENT_INTERRUPT_WAKE_MAX_RESUMES = 3;

type AppendSubagentReceipt = (input: {
  parentSession: Session;
  parentTurnId?: string | null;
  run: SubagentRun;
  childSession?: Session | null;
  eventName: Extract<RuntimeEvent["name"], `subagent.${string}`>;
  status: RuntimeEvent["status"];
  output: string;
}) => Promise<void>;

type WorkspaceHandoff = {
  changed: boolean;
  changedFiles: string[];
  artifacts: NonNullable<SubagentRun["report"]>["artifacts"];
  patchRef: NonNullable<SubagentRun["report"]>["patchRef"];
  diffRef: NonNullable<SubagentRun["report"]>["diffRef"];
  metadata: Record<string, unknown>;
};

export function createSubagentChildTurnRuntime(deps: {
  requireSubagentDeps(): {
    getRun(runId: string): Promise<SubagentRun | null>;
    upsertRun(run: SubagentRun): Promise<unknown>;
  };
  sendTurn(sessionId: string, payload: unknown): Promise<Turn>;
  getTurn(turnId: string): Promise<Turn | null>;
  latestAssistantTextForSession(sessionId: string): Promise<string | null>;
  appendSubagentReceipt: AppendSubagentReceipt;
  refreshSubagentRuntimeDerivedProgress(input: {
    run: SubagentRun;
    childSessionId: string;
    phase?: SubagentProgress["phase"] | null;
    latestMeaningfulActivity?: string | null;
    currentBlocker?: string | null;
  }): Promise<SubagentRun>;
  subagentRuntimeDerivedProgress(input: {
    run: SubagentRun;
    childSessionId: string;
    phase?: SubagentProgress["phase"] | null;
    latestMeaningfulActivity?: string | null;
    currentBlocker?: string | null;
  }): Promise<SubagentProgress>;
  subagentUsageAttribution(run: SubagentRun): UsageRequestAttribution;
  subagentUsageTotalsForRun(runId: string): Promise<{
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    requestCount: number;
  }>;
  captureSubagentWorkspaceHandoff(run: SubagentRun): Promise<WorkspaceHandoff | null>;
  applySubagentPatch(run: SubagentRun): Promise<Record<string, unknown> | null>;
  appendWorkspaceDiffEvent(session: Session, turnId: string): Promise<void>;
  uniqueSubagentRefs(values: readonly (SubagentRef | null | undefined)[]): SubagentRef[];
  withSubagentInterruptWakeMetadata(
    metadata: Record<string, unknown> | undefined,
    wake: Record<string, unknown>,
  ): Record<string, unknown>;
}) {
  const requireSubagentDeps = deps.requireSubagentDeps;
  const sendTurn = deps.sendTurn;
  const getStoredTurn = deps.getTurn;
  const appendSubagentReceipt = deps.appendSubagentReceipt;
  const refreshSubagentRuntimeDerivedProgress = deps.refreshSubagentRuntimeDerivedProgress;
  const subagentRuntimeDerivedProgress = deps.subagentRuntimeDerivedProgress;
  const subagentUsageAttribution = deps.subagentUsageAttribution;
  const subagentUsageTotalsForRun = deps.subagentUsageTotalsForRun;
  const captureSubagentWorkspaceHandoff = deps.captureSubagentWorkspaceHandoff;
  const applySubagentPatch = deps.applySubagentPatch;
  const appendWorkspaceDiffEvent = deps.appendWorkspaceDiffEvent;
  const uniqueSubagentRefs = deps.uniqueSubagentRefs;
  const withSubagentInterruptWakeMetadata = deps.withSubagentInterruptWakeMetadata;
  const store = { latestAssistantTextForSession: deps.latestAssistantTextForSession };
  const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  async function runSubagentChildTurn(input: {
    run: SubagentRun;
    role: SubagentRoleSettings;
    childSession: Session;
    parentSession: Session;
    parentTurnId: string;
    contextPack: string | null;
    workerBrief: SubagentWorkerBrief;
    childTurnPermissions: SubagentTurnPermissions;
  }): Promise<void> {
    const deps = requireSubagentDeps();
    const latestBeforeStart = await deps.getRun(input.run.id);
    if (latestBeforeStart?.status === "cancelled") return;
    const startedAt = now();
    let run = SubagentRunSchema.parse({
      ...(latestBeforeStart ?? input.run),
      status: "running",
      startedAt,
      progress: SubagentProgressSchema.parse({
        ...((latestBeforeStart ?? input.run).progress ?? {}),
        phase: "orient",
        latestMeaningfulActivity: "Child subagent turn started.",
        currentBlocker: null,
        updatedAt: startedAt,
      }),
    });
    await deps.upsertRun(run);
    await appendSubagentReceipt({
      parentSession: input.parentSession,
      parentTurnId: input.parentTurnId,
      run,
      eventName: "subagent.started",
      status: "started",
      output: `${run.roleId} subagent is running.`,
    });
    await appendSubagentReceipt({
      parentSession: input.parentSession,
      parentTurnId: input.parentTurnId,
      run,
      eventName: "subagent.progress",
      status: "pending",
      output: `${run.roleId} subagent is working in child conversation ${run.childSessionId ?? "unknown"}.`,
    });
    try {
      let childPrompt = subagentChildPrompt({
        objective: input.run.objective,
        contextPack: input.contextPack,
        workerBrief: input.workerBrief,
      });
      let wakeResumeCount = 0;
      while (true) {
        const childTurn = await sendTurn(input.childSession.id, {
          prompt: childPrompt,
          modelRef: input.run.modelRef ?? undefined,
          metadata: {
            subagentRunId: input.run.id,
            parentSessionId: input.parentSession.id,
            parentTurnId: input.parentTurnId,
            parentGoalId: input.run.parentGoalId,
            subagentRoleId: input.run.roleId,
            subagentPermissions: input.childTurnPermissions,
            usageAttribution: subagentUsageAttribution(input.run),
          },
          usageAttribution: subagentUsageAttribution(input.run),
          approvalPolicy: input.childTurnPermissions.approvalPolicy,
          sandbox: input.childTurnPermissions.sandbox,
          codexPermissionMode: input.childTurnPermissions.codexPermissionMode,
          codexReasoningEffort: input.childTurnPermissions.codexReasoningEffort,
        });
        const finalizedChildTurn = await finalizedSubagentChildTurn(childTurn);
        const latestAfterChild = await deps.getRun(run.id);
        if (latestAfterChild?.status === "cancelled") return;
        run = latestAfterChild ?? run;
        run = await refreshSubagentRuntimeDerivedProgress({
          run,
          childSessionId: input.childSession.id,
        });
        if (finalizedChildTurn.status === "interrupted") {
          const wake = subagentInterruptWakeForTurn(run, finalizedChildTurn.id);
          if (wake && wakeResumeCount < SUBAGENT_INTERRUPT_WAKE_MAX_RESUMES) {
            wakeResumeCount += 1;
            run = await markSubagentInterruptWakeResuming({
              run,
              interruptedTurnId: finalizedChildTurn.id,
              wake,
              resumeCount: wakeResumeCount,
            });
            await appendSubagentReceipt({
              parentSession: input.parentSession,
              parentTurnId: input.parentTurnId,
              run,
              eventName: "subagent.progress",
              status: "pending",
              output: `${run.roleId} subagent is resuming after interrupt steering.`,
            });
            childPrompt = subagentInterruptWakeResumePrompt({
              run,
              interruptedTurnId: finalizedChildTurn.id,
              wake,
            });
            continue;
          }
        }
        if (finalizedChildTurn.status !== "completed") {
          throw new Error(finalizedChildTurn.error || `Child turn ended with status ${finalizedChildTurn.status}.`);
        }
        break;
      }
      const submittedAt = now();
      const summary = await store.latestAssistantTextForSession(input.childSession.id);
      const usage = await subagentUsageTotalsForRun(input.run.id);
      const workspaceHandoff = await captureSubagentWorkspaceHandoff(run);
      const derivedProgress = await subagentRuntimeDerivedProgress({
        run,
        childSessionId: input.childSession.id,
        phase: "submitted",
        latestMeaningfulActivity: "Child submitted a final report for parent review.",
        currentBlocker: null,
      });
      const handoffChangedFiles = uniqueNonEmptyStrings([
        ...(derivedProgress.changedFiles ?? []),
        ...(workspaceHandoff?.changedFiles ?? []),
      ]);
      const submittedReport = {
        summary: summary || "Child conversation completed.",
        findings: [],
        artifacts: workspaceHandoff?.artifacts ?? [],
        patchRef: workspaceHandoff?.patchRef ?? null,
        diffRef: workspaceHandoff?.diffRef ?? null,
        testsRun: [],
        blockers: [],
        confidence: null,
        followUpNeeded: workspaceHandoff?.changed ?? false,
      };
      const submittedProgress = SubagentProgressSchema.parse({
        ...derivedProgress,
        phase: "submitted",
        changedFiles: handoffChangedFiles,
        patchRefs: uniqueSubagentRefs([
          ...(derivedProgress.patchRefs ?? []),
          workspaceHandoff?.patchRef ?? null,
          workspaceHandoff?.diffRef ?? null,
        ]),
        latestMeaningfulActivity: "Child submitted a final report for parent review.",
        currentBlocker: derivedProgress.currentBlocker,
        updatedAt: submittedAt,
      });
      const packetQuality = subagentReviewPacketQuality({
        run,
        finalSummary: summary,
        report: submittedReport,
        progress: submittedProgress,
      });
      const submittedReviewReport: NonNullable<SubagentRun["report"]> = {
        ...submittedReport,
        confidence: packetQuality.status === "weak" ? "low" : submittedReport.confidence,
        followUpNeeded: submittedReport.followUpNeeded || packetQuality.status !== "reviewable",
      };
      const reviewRouting = subagentReviewRoutingRecommendation({
        run,
        reviewRoutingPolicy: input.role.reviewRouting,
        packetQuality,
        report: submittedReviewReport,
        progress: submittedProgress,
      });
      const packetIncomplete = packetQuality.status === "incomplete";
      const packetBlocker = packetQuality.issues[0] ?? "Child review packet is incomplete.";
      run = SubagentRunSchema.parse({
        ...run,
        status: packetIncomplete ? "blocked" : "submitted_for_review",
        completedAt: packetIncomplete ? submittedAt : null,
        error: packetIncomplete ? packetBlocker : null,
        report: {
          ...submittedReviewReport,
          blockers: packetIncomplete
            ? uniqueNonEmptyStrings([...submittedReviewReport.blockers, ...packetQuality.issues])
            : submittedReviewReport.blockers,
        },
        progress: SubagentProgressSchema.parse({
          ...submittedProgress,
          phase: packetIncomplete ? "report" : submittedProgress.phase,
          latestMeaningfulActivity: packetIncomplete
            ? "Child finished without a reviewable final report."
            : submittedProgress.latestMeaningfulActivity,
          currentBlocker: packetIncomplete ? packetBlocker : submittedProgress.currentBlocker,
        }),
        review: SubagentReviewStateSchema.parse({
          ...(run.review ?? {}),
          status: packetIncomplete ? "needs_user_input" : "submitted_for_review",
          submittedAt,
          summary: summary || submittedReport.summary,
          issues: packetIncomplete
            ? uniqueNonEmptyStrings([...(run.review?.issues ?? []), ...packetQuality.issues])
            : run.review?.issues ?? [],
          humanReviewRecommended: packetQuality.status !== "reviewable",
          ...reviewRouting,
          packetQuality,
        }),
        metadata: {
          ...(run.metadata ?? {}),
          usage,
          ...(workspaceHandoff ? { workspaceHandoff: workspaceHandoff.metadata } : {}),
        },
      });
      let patchApplyError: string | null = null;
      if (workspaceHandoff?.changed && !packetIncomplete && workspaceHandoff.metadata.patchPath) {
        try {
          const applyResult = await applySubagentPatch(run);
          if (applyResult) {
            run = SubagentRunSchema.parse({
              ...run,
              metadata: {
                ...(run.metadata ?? {}),
                workspaceHandoff: {
                  ...workspaceHandoff.metadata,
                  applyResult,
                },
              },
            });
            await appendWorkspaceDiffEvent(input.parentSession, input.parentTurnId).catch(() => undefined);
          }
        } catch (error) {
          patchApplyError = textFromUnknown(error) || "Unable to apply the isolated child patch.";
          run = SubagentRunSchema.parse({
            ...run,
            status: "needs_revision",
            error: patchApplyError,
            progress: SubagentProgressSchema.parse({
              ...run.progress,
              latestMeaningfulActivity: "Child patch could not be integrated automatically.",
              currentBlocker: patchApplyError,
              updatedAt: now(),
            }),
            review: SubagentReviewStateSchema.parse({
              ...run.review,
              status: "needs_revision",
              issues: uniqueNonEmptyStrings([...(run.review.issues ?? []), patchApplyError]),
              requiredCorrections: uniqueNonEmptyStrings([
                ...(run.review.requiredCorrections ?? []),
                "Reconcile the child changes with the current shared workspace and resubmit.",
              ]),
              humanReviewRecommended: false,
            }),
          });
        }
      }
      await deps.upsertRun(run);
      if (workspaceHandoff?.changed && !packetIncomplete) {
        await appendSubagentReceipt({
          parentSession: input.parentSession,
          parentTurnId: input.parentTurnId,
          run,
          eventName: "subagent.reported",
          status: patchApplyError ? "failed" : "completed",
          output: patchApplyError
            ? `${run.roleId} subagent patch needs revision: ${patchApplyError}`
            : workspaceHandoff.metadata.patchPath
              ? `${run.roleId} subagent patch applied automatically to the shared workspace.`
              : `${run.roleId} subagent produced isolated workspace changes for parent review.`,
        });
      }
      await appendSubagentReceipt({
        parentSession: input.parentSession,
        parentTurnId: input.parentTurnId,
        run,
        eventName: packetIncomplete ? "subagent.blocked" : patchApplyError ? "subagent.needs_revision" : "subagent.submitted",
        status: packetIncomplete || patchApplyError ? "failed" : "pending",
        output: packetIncomplete
          ? `${run.roleId} subagent submitted an incomplete review packet: ${packetBlocker}`
          : patchApplyError
            ? `${run.roleId} subagent needs revision after automatic integration failed.`
          : `${run.roleId} subagent submitted a review packet.`,
      });
    } catch (error) {
      const latestAfterError = await deps.getRun(run.id).catch(() => null);
      if (latestAfterError?.status === "cancelled") return;
      const message = textFromUnknown(error) || "Subagent failed.";
      const failedAt = now();
      const workspaceHandoff = await captureSubagentWorkspaceHandoff(run).catch(() => null);
      const failedWithArtifacts = Boolean(workspaceHandoff?.changed || workspaceHandoff?.artifacts.length);
      const derivedProgress = await subagentRuntimeDerivedProgress({
        run,
        childSessionId: input.childSession.id,
        phase: "report",
        latestMeaningfulActivity: failedWithArtifacts
          ? "Child failed after producing recoverable artifacts."
          : "Child failed before producing a final report.",
        currentBlocker: message,
      });
      const validationAttempts = derivedProgress.validationAttempts ?? [];
      const lastValidationAttempt = validationAttempts.at(-1) ?? null;
      const failureBlockers = uniqueNonEmptyStrings([
        message,
        ...(derivedProgress.currentBlocker ? [derivedProgress.currentBlocker] : []),
      ]);
      const handoffChangedFiles = uniqueNonEmptyStrings([
        ...(derivedProgress.changedFiles ?? []),
        ...(workspaceHandoff?.changedFiles ?? []),
      ]);
      const failureHandoff = {
        status: failedWithArtifacts ? "recoverable_artifacts" : "failed_without_artifacts",
        capturedAt: failedAt,
        error: message,
        confidence: "low",
        changedFiles: handoffChangedFiles,
        patchRef: workspaceHandoff?.patchRef ?? null,
        diffRef: workspaceHandoff?.diffRef ?? null,
        artifacts: workspaceHandoff?.artifacts ?? [],
        validationAttempts,
        lastValidationAttempt,
        blockers: failureBlockers,
      };
      const failureReport: NonNullable<SubagentRun["report"]> = {
        summary: failedWithArtifacts
          ? "Child conversation failed after producing recoverable artifacts."
          : "Child conversation failed before producing a final report.",
        findings: [],
        artifacts: workspaceHandoff?.artifacts ?? [],
        patchRef: workspaceHandoff?.patchRef ?? null,
        diffRef: workspaceHandoff?.diffRef ?? null,
        testsRun: uniqueNonEmptyStrings(validationAttempts.map((attempt) => attempt.command)),
        blockers: failureBlockers,
        confidence: "low",
        followUpNeeded: true,
      };
      const failureProgress = SubagentProgressSchema.parse({
        ...derivedProgress,
        phase: "report",
        changedFiles: handoffChangedFiles,
        patchRefs: uniqueSubagentRefs([
          ...(derivedProgress.patchRefs ?? []),
          workspaceHandoff?.patchRef ?? null,
          workspaceHandoff?.diffRef ?? null,
        ]),
        latestMeaningfulActivity: failedWithArtifacts
          ? "Child failed after producing recoverable artifacts."
          : "Child failed before producing a final report.",
        currentBlocker: message,
        updatedAt: failedAt,
      });
      const failureReviewRouting = failedWithArtifacts
        ? subagentReviewRoutingRecommendation({
            run,
            reviewRoutingPolicy: input.role.reviewRouting,
            packetQuality: run.review.packetQuality,
            report: failureReport,
            progress: failureProgress,
            providerFailureAfterChanges: handoffChangedFiles.length > 0,
          })
        : null;
      run = SubagentRunSchema.parse({
        ...run,
        status: failedWithArtifacts ? "failed_with_artifacts" : "failed",
        completedAt: failedAt,
        error: message,
        report: failureReport,
        progress: failureProgress,
        review: failedWithArtifacts
          ? SubagentReviewStateSchema.parse({
              ...(run.review ?? {}),
              status: "failed_with_artifacts",
              submittedAt: failedAt,
              summary: "Child failed after producing recoverable artifacts.",
              issues: failureBlockers,
              humanReviewRecommended: true,
              ...(failureReviewRouting ?? {}),
            })
          : run.review,
        metadata: {
          ...(run.metadata ?? {}),
          ...(workspaceHandoff ? { workspaceHandoff: workspaceHandoff.metadata } : {}),
          failureHandoff,
        },
      });
      await deps.upsertRun(run);
      await appendSubagentReceipt({
        parentSession: input.parentSession,
        parentTurnId: input.parentTurnId,
        run,
        eventName: "subagent.failed",
        status: "failed",
        output: failedWithArtifacts
          ? `${run.roleId} subagent failed after producing recoverable artifacts: ${message}`
          : `${run.roleId} subagent failed: ${message}`,
      });
    }
  }

  async function finalizedSubagentChildTurn(turn: Turn): Promise<Turn> {
    let latest = (await getStoredTurn(turn.id)) ?? turn;
    if (latest.status !== "in_progress") return latest;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      await delay(250);
      latest = (await getStoredTurn(turn.id)) ?? latest;
      if (latest.status !== "in_progress") return latest;
    }
    return latest;
  }

  function subagentInterruptWakeForTurn(run: SubagentRun, turnId: string): Record<string, unknown> | null {
    const wake = recordFromUnknown(recordFromUnknown(run.metadata)?.interruptWake);
    if (!wake) return null;
    if (stringFromRecord(wake, "activeTurnId") !== turnId) return null;
    const status = stringFromRecord(wake, "status");
    if (status !== "interrupted" && status !== "interrupting") return null;
    if (!stringFromRecord(wake, "messageId")) return null;
    return wake;
  }

  async function markSubagentInterruptWakeResuming(input: {
    run: SubagentRun;
    interruptedTurnId: string;
    wake: Record<string, unknown>;
    resumeCount: number;
  }): Promise<SubagentRun> {
    const deps = requireSubagentDeps();
    const updated = SubagentRunSchema.parse({
      ...input.run,
      status: "running",
      completedAt: null,
      error: null,
      metadata: withSubagentInterruptWakeMetadata(input.run.metadata, {
        ...input.wake,
        status: "resuming",
        interruptedTurnId: input.interruptedTurnId,
        resumeCount: input.resumeCount,
        resumedAt: now(),
      }),
    });
    await deps.upsertRun(updated);
    return updated;
  }

  function subagentInterruptWakeResumePrompt(input: {
    run: SubagentRun;
    interruptedTurnId: string;
    wake: Record<string, unknown>;
  }): string {
    const messageId = stringFromRecord(input.wake, "messageId") ?? "unknown";
    return [
      "A high-priority subagent mailbox message interrupted your previous child turn.",
      `Message id: ${messageId}`,
      `Interrupted turn: ${input.interruptedTurnId}`,
      `Original assignment: ${input.run.objective}`,
      "Read the Subagent mailbox interrupt in this turn context, apply that steering, and continue the assignment.",
      "If the interrupted work was a wait, sleep, or polling command, do not repeat it unless the updated assignment still requires it.",
    ].join("\n");
  }


  return { runSubagentChildTurn };
}
