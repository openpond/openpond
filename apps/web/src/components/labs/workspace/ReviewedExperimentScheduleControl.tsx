import {useReviewedOperationRecovery} from "./useReviewedOperationRecovery";
import {ReviewedOperationRecoveryList} from "./ReviewedOperationRecoveryList";
import type {EvaluationOperationRecovery} from "@openpond/contracts";
import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { contentHash } from "@openpond/harness";
import {
  ExperimentEvaluationScheduleCommandSchema,verifyExperimentEvaluationSchedule,
  scheduledExperimentHash,
  type ExperimentEvaluationSchedule,
} from "openpond-sdk/experiment-evaluation-schedules";
import type { RunExperimentSchema } from "openpond-sdk/experiments";
import type { z } from "zod";
import type { WorkspaceApi } from "./workspace-api";
import { WorkspacePanel, useWorkspaceActions } from "./WorkspacePanel";
import { useDraftNavigation } from "../useDraftNavigation";
import {
  advancedEvaluationRequest,
  evaluationOwnerKey,
} from "./advanced-evaluation-api";
/** Exact reviewed setup only; opening and inspecting history starts no compute. */
export function ReviewedExperimentScheduleControl({
  api,
  configuration,
  onOpenExperiment,
}: {
  api: WorkspaceApi;
  configuration: z.infer<typeof RunExperimentSchema> | null;
  onOpenExperiment?: (id: string) => void;
}) {
  const [open, setOpen] = useState(false),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    guard = useDraftNavigation({
      name: "evaluation schedule",
      dirty,
      busy,
      onLeave: () => setOpen(false),
    });
  useWorkspaceActions(
    configuration
      ? [
          {
            id: "scheduled-evaluations",
            label: "Scheduled evaluations",
            onSelect: () => setOpen(true),
          },
        ]
      : [],
  );
  return (
    <>
      {open && configuration ? (
        <WorkspacePanel
          label="Scheduled evaluations"
          action="scheduled-evaluations"
          onRequestClose={() => void guard.requestLeave(() => setOpen(false))}
        >
          <ScheduleEditor
            key={contentHash([
              evaluationOwnerKey(api),
              scheduledExperimentHash(configuration),
            ])}
            api={api}
            configuration={configuration}
            requestChange={(action) => void guard.requestLeave(action)}
            onDirty={setDirty}
            onBusy={setBusy}
            onOpenExperiment={onOpenExperiment}
          />
        </WorkspacePanel>
      ) : null}
      {guard.dialog}
    </>
  );
}
function ScheduleEditor({
  api,
  configuration,
  onDirty,
  requestChange,
  onBusy,
  onOpenExperiment,
}: {
  api: WorkspaceApi;
  configuration: z.infer<typeof RunExperimentSchema>;
  onDirty: (v: boolean) => void;
  requestChange: (action: () => void) => void;
  onBusy: (v: boolean) => void;
  onOpenExperiment?: (id: string) => void;
}) {
  const queryClient = useQueryClient(),
    scope = evaluationOwnerKey(api),
    current = useRef(scope);
  current.current = scope;
  const [schedule, setSchedule] = useState<ExperimentEvaluationSchedule | null>(
      null,
    ),
    [enabled, setEnabled] = useState(false),
    [cadence, setCadence] = useState<"interval" | "nightly">("interval"),
    [minutes, setMinutes] = useState(1440),
    [time, setTime] = useState("02:00"),
    [zone, setZone] = useState(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    ),
    [budget, setBudget] = useState(configuration.maximumCostUsd),
    [attempts, setAttempts] = useState(1),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const pending = useRef<{
      scope: string;
      request: unknown;
      operation: Awaited<ReturnType<WorkspaceApi["operation"]>>;
    } | null>(null),
    abort = useRef<AbortController | null>(null),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abort.current?.abort();
    };
  }, []);
  useEffect(() => {
    onBusy(busy);
    return () => onBusy(false);
  }, [busy, onBusy]);
  const recovery=useReviewedOperationRecovery(api,"experiment-evaluation-schedule");
  const retainedRows=recovery.data?.pages.flatMap(page=>page.items)??[];
  async function discard(row:EvaluationOperationRecovery){
    const started=scope;setBusy(true);try{await api.recoverOperation(row).acknowledge("reviewed");if(mounted.current&&current.current===started){if(pending.current?.operation.id===row.id)pending.current=null;await recovery.refetch();onDirty(false);}}catch(cause){if(mounted.current&&current.current===started)setError(cause instanceof Error?cause.message:String(cause));}finally{if(mounted.current&&current.current===started)setBusy(false);}
  }
  function restore(row:EvaluationOperationRecovery){
    try{if(!row.recoveryReady||contentHash(row.reviewedIntent)!==row.intentHash)throw new Error("The original reviewed intent is unavailable.");
      const request=ExperimentEvaluationScheduleCommandSchema.parse(row.command);if(request.operation!=="publish"&&request.operation!=="control")throw new Error("The retained command is not an owner action.");
      if(request.request.operationId!==row.id||request.request.teamId!==api.teamId)throw new Error("The retained command belongs to another owner scope.");
      pending.current={scope,request,operation:api.recoverOperation(row)};onDirty(true);setError(null);
    }catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
  }
  const key = ["evaluation-schedules", scope],
    history = useInfiniteQuery({
      queryKey: key,
      initialPageParam: undefined as string|undefined,
      getNextPageParam: (page:{items:ExperimentEvaluationSchedule[];nextCursor:string|null}) => page.nextCursor??undefined,
      queryFn: async ({ signal, pageParam }) => {
        const raw = await advancedEvaluationRequest<{
          items: unknown[];
          nextCursor: string | null;
        }>(
          api,
          "experiment-evaluation-schedules",
          { operation: "list", limit: 100, ...(pageParam?{cursor:pageParam}:{}) },
          signal,
        );
        return {items:raw.items.map(verifyExperimentEvaluationSchedule),nextCursor:raw.nextCursor};
      },
      refetchInterval: 5000,
    });
  const exactHash = scheduledExperimentHash(configuration),
    matching =
      history.data?.pages.flatMap(page=>page.items).filter((row) => row.configurationHash === exactHash) ?? [];
  const poll = useQuery({
    queryKey: [...key, schedule?.id],
    enabled: Boolean(schedule),
    queryFn: async ({ signal }) =>
      verifyExperimentEvaluationSchedule(
        await advancedEvaluationRequest(
          api,
          "experiment-evaluation-schedules",
          { operation: "read", id: schedule!.id },
          signal,
        ),
      ),
    refetchInterval: 3000,
  });
  useEffect(() => {
    if (
      poll.data &&
      poll.data.id === schedule?.id &&
      poll.data.revision >= schedule.revision
    )
      setSchedule(poll.data);
  }, [poll.data, schedule]);
  function change(fn: () => void) {
    if (busy || pending.current) return;
    fn();
    onDirty(true);
  }
  function select(value: ExperimentEvaluationSchedule) {
    setSchedule(value);
    setEnabled(value.state !== "disabled");
    setBudget(value.maximumTotalSpendUsd);
    setAttempts(value.maximumAttempts);
    setCadence(value.cadence.kind);
    if (value.cadence.kind === "interval")
      setMinutes(value.cadence.seconds / 60);
    else {
      setTime(value.cadence.calendar.localTime);
      setZone(value.cadence.calendar.timeZone);
    }
    onDirty(false);
  }
  async function perform(intent: unknown, build: (id: string) => unknown) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const started = scope,
      controller = new AbortController();
    abort.current = controller;
    try {
      let retained = pending.current;
      if (retained && retained.scope !== started)
        throw new Error(
          "The pending schedule command belongs to another scope.",
        );
      if (!retained) {
        const operation = await api.operation(
          "experiment-evaluation-schedule",
          intent,
        );
        if (!mounted.current || current.current !== started) return;
        retained = { scope: started, request: build(operation.id), operation };
        pending.current = retained;
      }
      await retained.operation.retainCommand(retained.request,"dispatching");
      if(!mounted.current||current.current!==started)return;
      const next = verifyExperimentEvaluationSchedule(
        await advancedEvaluationRequest(
          api,
          "experiment-evaluation-schedules",
          retained.request,
          controller.signal,
        ),
      );
      if (!mounted.current || current.current !== started) return;
      select(next);
      await retained.operation.acknowledge();
      if (!mounted.current || current.current !== started) return;
      pending.current = null;
      await recovery.refetch();
      if(!mounted.current||current.current!==started)return;
      await queryClient.invalidateQueries({ queryKey: key });
    } catch (cause) {
      if (mounted.current && current.current === started)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mounted.current && current.current === started) setBusy(false);
      if (abort.current === controller) abort.current = null;
    }
  }
  const calendar = { localTime: time, timeZone: zone },
    policyCadence =
      cadence === "interval"
        ? { kind: "interval" as const, seconds: Math.round(minutes * 60) }
        : { kind: "nightly" as const, calendar };
  const intent = {
    id: schedule?.id,
    expectedRevision: schedule?.revision ?? 0,
    teamId: api.teamId,
    projectId: api.projectId,
    configuration,
    enabled,
    cadence: policyCadence,
    maximumTotalSpendUsd: budget,
    maximumAttempts: attempts,
  };
  return (
    <div className="evaluation-form">
      <h2>Scheduled evaluations</h2>
      <ReviewedOperationRecoveryList items={retainedRows} busy={busy} error={recovery.error?.message} onRestore={restore} onDiscard={row=>void discard(row)} onLoadMore={recovery.hasNextPage?()=>void recovery.fetchNextPage():undefined}/>
      {pending.current?<p>Frozen command: {pending.current.operation.id}. This retry uses the original retained setup and limits, even if the current parent setup differs.</p>:null}
      <p>
        Execution owner: this connected app server. It must remain running.
        Each occurrence evaluates this pinned recipe within the cumulative limits;
        no source release is advanced automatically.
      </p>
      <p>
        Saved schedules run the exact reviewed Dataset, target and graders. New
        releases are shown for review and never selected automatically.
      </p>
      {(error ?? history.error?.message ?? poll.error?.message) ? (
        <p role="alert">
          {error ?? history.error?.message ?? poll.error?.message}
        </p>
      ) : null}
      <label>
        Existing schedule
        <select
          disabled={busy || Boolean(pending.current)}
          value={schedule?.id ?? ""}
          onChange={(e) => {
            const row = matching.find((row) => row.id === e.target.value);
            requestChange(() => {
              if (row) select(row);
              else {
                setSchedule(null);
                setEnabled(false);
                setCadence("interval");
                setMinutes(1440);
                setTime("02:00");
                setZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
                setBudget(configuration.maximumCostUsd);
                setAttempts(1);
                onDirty(false);
              }
            });
          }}
        >
          <option value="">New schedule for this setup</option>
          {matching.map((row) => (
            <option key={row.id} value={row.id}>
              {row.id} / {row.state} / revision {row.revision}
            </option>
          ))}
        </select>
      </label>
      {history.hasNextPage?<button type="button" disabled={history.isFetchingNextPage} onClick={()=>void history.fetchNextPage()}>Load more schedules</button>:null}
      <fieldset disabled={busy || Boolean(pending.current)}>
        <label>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => change(() => setEnabled(e.target.checked))}
          />
          Enable scheduled evaluations
        </label>
        <label>
          Cadence
          <select
            value={cadence}
            onChange={(e) =>
              change(() =>
                setCadence(
                  e.target.value === "nightly" ? "nightly" : "interval",
                ),
              )
            }
          >
            <option value="interval">Interval</option>
            <option value="nightly">Nightly</option>
          </select>
        </label>
        {cadence === "interval" ? (
          <label>
            Interval minutes
            <input
              type="number"
              min={1}
              max={525600}
              value={minutes}
              onChange={(e) => change(() => setMinutes(Number(e.target.value)))}
            />
          </label>
        ) : (
          <>
            <label>
              Local time
              <input
                type="time"
                value={time}
                onChange={(e) => change(() => setTime(e.target.value))}
              />
            </label>
            <label>
              Time zone
              <input
                value={zone}
                onChange={(e) => change(() => setZone(e.target.value))}
              />
            </label>
          </>
        )}
        <label>
          Cumulative budget USD
          <input
            type="number"
            min={configuration.maximumCostUsd}
            value={budget}
            onChange={(e) => change(() => setBudget(Number(e.target.value)))}
          />
        </label>
        <label>
          Maximum attempts
          <input
            type="number"
            min={1}
            max={20}
            value={attempts}
            onChange={(e) => change(() => setAttempts(Number(e.target.value)))}
          />
        </label>
      </fieldset>
      <p>
        Per-occurrence ceiling {configuration.maximumCostUsd} USD. Exact recipe{" "}
        {exactHash}.
      </p>
      <button
        type="button"
        className="training-button"
        disabled={busy||recovery.isPending||Boolean(recovery.error)}
        onClick={() =>
          void perform(intent, (id) => ({
            operation: "publish",
            request: { ...intent, operationId: id },
          }))
        }
      >
        {pending.current ? "Retry retained command" : "Save schedule"}
      </button>
      {schedule ? (
        <>
          <p>
            {schedule.state} / next {schedule.nextRunAt ?? "none"}
          </p>
          {schedule.reason ? <p>{schedule.reason}</p> : null}
          {schedule.newerUnevaluatedRelease ? (
            <p>
              Newer unevaluated Dataset: {schedule.newerUnevaluatedRelease.id} /{" "}
              {schedule.newerUnevaluatedRelease.contentHash}. Review a new setup
              before changing this schedule.
            </p>
          ) : null}
          {(["pause", "cancel_active", "retry_active"] as const).map(
            (action) => (
              <button
                type="button"
                key={action}
                disabled={busy || Boolean(pending.current)}
                onClick={() =>
                  void perform(
                    { id: schedule.id, revision: schedule.revision, action },
                    (id) => ({
                      operation: "control",
                      request: {
                        teamId: api.teamId,
                        id: schedule.id,
                        expectedRevision: schedule.revision,
                        operationId: id,
                        action,
                      },
                    }),
                  )
                }
              >
                {action.replaceAll("_", " ")}
              </button>
            ),
          )}
          <ol>
            {schedule.fires.map((fire) => (
              <li key={fire.id}>
                {fire.scheduledAt} / {fire.state} /{" "}
                {fire.actualSpendUsd === null
                  ? "Spend unresolved"
                  : `${fire.actualSpendUsd} USD`}{" "}
                / cleanup {fire.cleanupComplete ? "complete" : "pending"}
                {fire.coalescedCount
                  ? ` / coalesced ${fire.coalescedCount}`
                  : ""}
                {fire.executionId && onOpenExperiment ? (
                  <button
                    type="button"
                    onClick={() => onOpenExperiment(fire.executionId!)}
                  >
                    Open actual Experiment
                  </button>
                ) : null}
                {fire.error ? <p>{fire.error}</p> : null}
              </li>
            ))}
          </ol>
        </>
      ) : null}
    </div>
  );
}
