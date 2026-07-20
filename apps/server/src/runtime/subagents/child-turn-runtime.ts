import {
  SubagentProgressSchema,
  SubagentRunSchema,
  type RuntimeEvent,
  type Session,
  type SubagentProgress,
  type SubagentRef,
  type SubagentRoleSettings,
  type SubagentRun,
  type Turn,
  type UsageRequestAttribution,
} from "@openpond/contracts";
import {
  subagentChildPrompt,
} from "./policies-and-prompts.js";
import type { SubagentTurnPermissions } from "./continuation-runtime.js";
import type { BackgroundWorkerQueue } from "../background-worker-queue.js";
import { now, textFromUnknown } from "../../utils.js";
import {
  recordFromUnknown,
  stringFromRecord,
  truncateForModelAside,
  uniqueNonEmptyStrings,
} from "../turns/value-utils.js";

const SUBAGENT_INTERRUPT_WAKE_MAX_RESUMES = 3;
const SUBAGENT_REPORT_SUMMARY_MAX_CHARS = 20_000;

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
    listRuns(input: {
      parentSessionId?: string;
      parentGoalId?: string;
      status?: SubagentRun["status"][];
      limit?: number;
    }): Promise<SubagentRun[]>;
    queue: BackgroundWorkerQueue;
  };
  sendTurn(sessionId: string, payload: unknown): Promise<Turn>;
  getTurn(turnId: string): Promise<Turn | null>;
  getPersistedRun(runId: string): Promise<SubagentRun | null>;
  upsertPersistedRun(run: SubagentRun): Promise<SubagentRun>;
  notifyRunStateChanged?: ((run: SubagentRun) => void) | null;
  latestTurnForSession(sessionId: string): Promise<Turn | null>;
  latestAssistantTextForSession(sessionId: string): Promise<string | null>;
  appendSubagentReceipt: AppendSubagentReceipt;
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
  notifyParentOfSubagentCompletion(input: {
    run: SubagentRun;
    parentSession: Session;
    childSession: Session;
    childTurnId: string;
    body: string;
    refs?: SubagentRef[];
  }): Promise<unknown>;
}) {
  const requireSubagentDeps = deps.requireSubagentDeps;
  const sendTurn = deps.sendTurn;
  const getStoredTurn = deps.getTurn;
  const getPersistedRun = deps.getPersistedRun;
  const upsertPersistedRun = deps.upsertPersistedRun;
  const notifyRunStateChanged = deps.notifyRunStateChanged;
  const latestTurnForSession = deps.latestTurnForSession;
  const appendSubagentReceipt = deps.appendSubagentReceipt;
  const subagentRuntimeDerivedProgress = deps.subagentRuntimeDerivedProgress;
  const subagentUsageAttribution = deps.subagentUsageAttribution;
  const subagentUsageTotalsForRun = deps.subagentUsageTotalsForRun;
  const captureSubagentWorkspaceHandoff = deps.captureSubagentWorkspaceHandoff;
  const applySubagentPatch = deps.applySubagentPatch;
  const appendWorkspaceDiffEvent = deps.appendWorkspaceDiffEvent;
  const uniqueSubagentRefs = deps.uniqueSubagentRefs;
  const withSubagentInterruptWakeMetadata = deps.withSubagentInterruptWakeMetadata;
  const notifyParentOfSubagentCompletion = deps.notifyParentOfSubagentCompletion;
  const store = { latestAssistantTextForSession: deps.latestAssistantTextForSession };
  const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  async function runSubagentChildTurn(input: {
    run: SubagentRun;
    role: SubagentRoleSettings;
    childSession: Session;
    parentSession: Session;
    parentTurnId: string;
    contextPack: string | null;
    childTurnPermissions: SubagentTurnPermissions;
    initialPrompt?: string | null;
  }): Promise<void> {
    const deps = requireSubagentDeps();
    const latestBeforeStart = await deps.getRun(input.run.id);
    // A queued child can be paused or cancelled while its
    // background job is waiting. Never let that stale job overwrite the
    // lifecycle decision by forcing the run back to running.
    if (latestBeforeStart && latestBeforeStart.status !== "queued") return;
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
    let lastChildTurnId = `failed_${run.id}`;
    try {
      let childPrompt = input.initialPrompt?.trim() || subagentChildPrompt({
        objective: input.run.objective,
        contextPack: input.contextPack,
      });
      let wakeResumeCount = 0;
      while (true) {
        const childTurn = await sendManagedSubagentTurn(input.childSession.id, input.run.id, {
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
        lastChildTurnId = finalizedChildTurn.id;
        const latestAfterChild = await getPersistedRun(run.id);
        if (latestAfterChild?.status === "cancelled") return;
        run = latestAfterChild ?? run;
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
      const completedAt = now();
      const assistantSummary = await store.latestAssistantTextForSession(input.childSession.id);
      const usage = await subagentUsageTotalsForRun(input.run.id);
      const observedProgress = await subagentRuntimeDerivedProgress({
        run,
        childSessionId: input.childSession.id,
        phase: "report",
        latestMeaningfulActivity: "Child conversation completed.",
      });
      const workspaceHandoff = await captureSubagentWorkspaceHandoff(run);
      const changedFiles = uniqueNonEmptyStrings([
        ...observedProgress.changedFiles,
        ...(workspaceHandoff?.changedFiles ?? []),
      ]);
      let patchApplyError: string | null = null;
      run = SubagentRunSchema.parse({
        ...run,
        status: "completed",
        completedAt,
        error: null,
        report: {
          summary: truncateForModelAside(
            assistantSummary || "Child conversation completed.",
            SUBAGENT_REPORT_SUMMARY_MAX_CHARS,
          ),
          findings: [],
          artifacts: workspaceHandoff?.artifacts ?? [],
          patchRef: workspaceHandoff?.patchRef ?? null,
          diffRef: workspaceHandoff?.diffRef ?? null,
          testsRun: observedProgress.validationAttempts.map((attempt) => attempt.command),
          blockers: [],
          confidence: null,
          followUpNeeded: false,
        },
        progress: SubagentProgressSchema.parse({
          ...observedProgress,
          phase: "report",
          changedFiles,
          patchRefs: uniqueSubagentRefs([
            ...observedProgress.patchRefs,
            workspaceHandoff?.patchRef ?? null,
            workspaceHandoff?.diffRef ?? null,
          ]),
          latestMeaningfulActivity: "Child conversation completed.",
          currentBlocker: null,
          updatedAt: completedAt,
        }),
        metadata: {
          ...run.metadata,
          usage,
          ...(workspaceHandoff ? { workspaceHandoff: workspaceHandoff.metadata } : {}),
        },
      });
      await upsertPersistedRun(run);
      if (workspaceHandoff?.changed && workspaceHandoff.metadata.patchPath) {
        try {
          const applyResult = await applySubagentPatch(run);
          if (applyResult) {
            run = SubagentRunSchema.parse({
              ...run,
              metadata: {
                ...run.metadata,
                workspaceHandoff: { ...workspaceHandoff.metadata, applyResult },
              },
            });
            await appendWorkspaceDiffEvent(input.parentSession, input.parentTurnId).catch(() => undefined);
          }
        } catch (error) {
          patchApplyError = textFromUnknown(error) || "Unable to apply the isolated child patch.";
          run = SubagentRunSchema.parse({
            ...run,
            status: "failed",
            error: patchApplyError,
            report: {
              ...run.report,
              blockers: [patchApplyError],
              followUpNeeded: true,
            },
            progress: SubagentProgressSchema.parse({
              ...run.progress,
              latestMeaningfulActivity: "Child completed, but its isolated patch could not be integrated.",
              currentBlocker: patchApplyError,
              updatedAt: now(),
            }),
          });
        }
      }
      await upsertPersistedRun(run);
      await appendSubagentReceipt({
        parentSession: input.parentSession,
        parentTurnId: input.parentTurnId,
        run,
        eventName: patchApplyError ? "subagent.failed" : "subagent.completed",
        status: patchApplyError ? "failed" : "completed",
        output: patchApplyError
          ? `${run.roleId} child completed but integration failed: ${patchApplyError}`
          : `${run.roleId} child completed.`,
      });
      await notifyParentOfSubagentCompletion({
        run,
        parentSession: input.parentSession,
        childSession: input.childSession,
        childTurnId: lastChildTurnId,
        body: patchApplyError
          ? `${run.report?.summary ?? "Child completed."}\n\nIntegration error: ${patchApplyError}`
          : run.report?.summary ?? "Child conversation completed.",
        refs: uniqueSubagentRefs([
          ...(run.report?.artifacts ?? []),
          run.report?.patchRef ?? null,
          run.report?.diffRef ?? null,
        ]),
      });
      notifyRunStateChanged?.(run);
    } catch (error) {
      const latestAfterError = await getPersistedRun(run.id).catch(() => null);
      if (latestAfterError && latestAfterError.status !== "running") return;
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
      const failureBlockers = uniqueNonEmptyStrings([
        message,
        ...(derivedProgress.currentBlocker ? [derivedProgress.currentBlocker] : []),
      ]);
      const handoffChangedFiles = uniqueNonEmptyStrings([
        ...(derivedProgress.changedFiles ?? []),
        ...(workspaceHandoff?.changedFiles ?? []),
      ]);
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
      run = SubagentRunSchema.parse({
        ...run,
        status: "failed",
        completedAt: failedAt,
        error: message,
        report: failureReport,
        progress: failureProgress,
        metadata: {
          ...(run.metadata ?? {}),
          ...(workspaceHandoff ? { workspaceHandoff: workspaceHandoff.metadata } : {}),
        },
      });
      await upsertPersistedRun(run);
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
      await notifyParentOfSubagentCompletion({
        run,
        parentSession: input.parentSession,
        childSession: input.childSession,
        childTurnId: lastChildTurnId,
        body: `${failureReport.summary}\n\nError: ${message}`,
        refs: uniqueSubagentRefs([
          ...failureReport.artifacts,
          failureReport.patchRef,
          failureReport.diffRef,
        ]),
      });
      notifyRunStateChanged?.(run);
    }
  }

  async function sendManagedSubagentTurn(
    childSessionId: string,
    runId: string,
    payload: Parameters<typeof sendTurn>[1],
  ): Promise<Turn> {
    const priorTurn = await latestTurnForSession(childSessionId);
    return await new Promise<Turn>((resolve, reject) => {
      let settled = false;
      let dispatchedTurnId: string | null = null;

      const settleWithTurn = (turn: Turn) => {
        if (settled || turn.status === "in_progress") return false;
        settled = true;
        resolve(turn);
        return true;
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      // A hosted dispatch may resolve before its durable turn is terminal, or
      // remain pending after SQLite has committed the terminal row. Whichever
      // source observes a terminal current turn first resolves this one gate.
      // Resolve directly from the provider callback instead of relying on a
      // later polling iteration to observe shared callback state.
      void sendTurn(childSessionId, payload).then(
        (turn) => {
          dispatchedTurnId = turn.id;
          settleWithTurn(turn);
        },
        fail,
      );

      const pollDurableTurn = async () => {
        while (!settled) {
          const latest = await latestTurnForSession(childSessionId);
          if (settled) return;
          const belongsToCurrentDispatch = Boolean(
            latest &&
            latest.metadata?.subagentRunId === runId &&
            (latest.id !== priorTurn?.id || latest.id === dispatchedTurnId),
          );
          if (latest && belongsToCurrentDispatch && settleWithTurn(latest)) return;
          await delay(250);
        }
      };
      void pollDurableTurn().catch(fail);
    });
  }

  async function finalizedSubagentChildTurn(turn: Turn): Promise<Turn> {
    // The provider callback can resolve with a terminal snapshot just before a
    // more authoritative failure is committed. Read through the short-lived
    // persisted lifecycle connection once; unlike the general store read, this
    // does not join a later provider-cleanup write and cannot recreate the
    // finalization deadlock.
    const persisted = await Promise.race([
      latestTurnForSession(turn.sessionId),
      delay(25).then(() => null),
    ]);
    if (persisted?.id === turn.id && persisted.status !== "in_progress") return persisted;
    if (turn.status !== "in_progress") return turn;
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
