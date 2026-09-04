import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type {
  ChatWorkflow,
  HostedSavedWorkDefinition,
  HostedSavedWorkRun,
  HostedSavedWorkSchedule,
  LocalAgentSchedule,
  LocalAgentScheduleRun,
  SavedWorkRecurrence,
  SavedWorkWeekday,
} from "@openpond/contracts";
import { api, type ClientConnection } from "../../api";
import { useErrorToast } from "../../app/AppToastContext";
import { useHostedSavedWork } from "../../hooks/useHostedSavedWork";
import { useChatWorkflows } from "../../hooks/useChatWorkflows";
import { useLocalAgentSchedules } from "../../hooks/useLocalAgentSchedules";
import {
  readScheduledWorkViewMode,
  writeScheduledWorkViewMode,
  type ScheduledWorkViewMode,
} from "../../lib/scheduled-work-view-preference";
import {
  ExternalLink,
  ListFilter,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  Trash2,
} from "../icons";
import {
  DetailField,
  DetailSection,
  EmptyMessage,
  LoadingMessage,
  LocalScheduleRunRow,
  ScheduleDetailPanel,
  ScheduleRunRow,
} from "./ScheduledWorkDetailParts";
import {
  ScheduledWorkCalendar,
  type ScheduledCalendarItem,
} from "./ScheduledWorkCalendar";
import {
  ChatWorkflowRow,
  HostedScheduleRow,
  LocalScheduleRow,
} from "./ScheduledWorkRows";
import { ChatWorkflowDetail } from "./ChatWorkflowDetail";
import {
  capitalize,
  formatLocalTime,
  formatScheduledRunAt,
} from "./scheduledWorkFormatting";
import {
  filterAndSortChatWorkflows,
  recurrenceCadence,
} from "./chatWorkflowFormatting";

export { formatScheduledRunAt } from "./scheduledWorkFormatting";

type ScheduleFilter = "active" | "paused" | "all";
type Frequency = SavedWorkRecurrence["kind"];
type ScheduledRow = {
  definition: HostedSavedWorkDefinition;
  schedule: HostedSavedWorkSchedule;
};
type CombinedScheduleRow =
  | { kind: "chat"; workflow: ChatWorkflow }
  | { kind: "local"; schedule: LocalAgentSchedule }
  | { kind: "hosted"; row: ScheduledRow };

const WEEKDAYS: SavedWorkWeekday[] = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

export function ScheduledWorkPage({
  connection,
  detailOpen,
  detailExpanded,
  onDetailOpenChange,
  onDetailResizeStart,
  onToggleDetailExpanded,
}: {
  connection: ClientConnection | null;
  detailOpen: boolean;
  detailExpanded: boolean;
  onDetailOpenChange: (open: boolean) => void;
  onDetailResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onToggleDetailExpanded: () => void;
}) {
  const savedWork = useHostedSavedWork(connection);
  const chatWorkflows = useChatWorkflows(connection);
  const localSchedules = useLocalAgentSchedules(connection);
  const [filter, setFilter] = useState<ScheduleFilter>("all");
  const [viewMode, setViewMode] = useState<ScheduledWorkViewMode>(
    readScheduledWorkViewMode,
  );
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const [selectedScheduleKey, setSelectedScheduleKey] = useState<string | null>(null);
  const rows = useMemo(
    () => scheduledRows(savedWork.definitions),
    [savedWork.definitions]
  );
  const visibleRows = useMemo(
    () => filterAndSortSchedules(rows, filter),
    [filter, rows]
  );
  const visibleLocalSchedules = useMemo(
    () => filterAndSortLocalSchedules(localSchedules.schedules, filter),
    [filter, localSchedules.schedules]
  );
  const visibleChatWorkflows = useMemo(
    () => filterAndSortChatWorkflows(chatWorkflows.workflows, filter),
    [chatWorkflows.workflows, filter],
  );
  const selectedHosted =
    rows.find((row) => hostedScheduleKey(row.schedule.id) === selectedScheduleKey) ?? null;
  const selectedLocal =
    localSchedules.schedules.find(
      (schedule) => localScheduleKey(schedule.id) === selectedScheduleKey
    ) ?? null;
  const selectedChat =
    chatWorkflows.workflows.find(
      (workflow) => chatWorkflowKey(workflow.id) === selectedScheduleKey,
    ) ?? null;
  const selectedRuns = selectedHosted
    ? savedWork.runs.filter((run) => run.scheduleId === selectedHosted.schedule.id)
    : [];
  const combinedRows = useMemo(
    () => combineScheduleRows(visibleChatWorkflows, visibleLocalSchedules, visibleRows),
    [visibleChatWorkflows, visibleLocalSchedules, visibleRows]
  );
  const calendarItems = useMemo<ScheduledCalendarItem[]>(
    () => combinedRows.map(calendarItemForRow),
    [combinedRows],
  );

  useErrorToast(savedWork.error, { prefix: "Workflows" });
  useErrorToast(localSchedules.error, { prefix: "Local schedules" });
  useErrorToast(chatWorkflows.error, { prefix: "Chat workflows" });

  useEffect(() => {
    if (selectedScheduleKey && !selectedHosted && !selectedLocal && !selectedChat) {
      setSelectedScheduleKey(null);
    }
  }, [selectedChat, selectedHosted, selectedLocal, selectedScheduleKey]);

  useEffect(() => {
    if (!detailOpen && selectedScheduleKey) setSelectedScheduleKey(null);
  }, [detailOpen, selectedScheduleKey]);

  useEffect(
    () => () => onDetailOpenChange(false),
    [onDetailOpenChange],
  );

  function selectSchedule(key: string) {
    setSelectedScheduleKey(key);
    onDetailOpenChange(true);
  }

  function closeDetail() {
    setSelectedScheduleKey(null);
    onDetailOpenChange(false);
  }

  function selectViewMode(mode: ScheduledWorkViewMode) {
    setViewMode(mode);
    writeScheduledWorkViewMode(mode);
  }

  async function refreshSchedules() {
    setManualRefreshing(true);
    try {
      await Promise.all([
        savedWork.refresh(),
        localSchedules.refresh(),
        chatWorkflows.refresh(),
      ]);
    } finally {
      setManualRefreshing(false);
    }
  }

  return (
    <section
      aria-label="Workflows"
      className={`scheduled-work-view${selectedHosted || selectedLocal || selectedChat ? " detail-open" : ""}${detailExpanded ? " detail-expanded" : ""}`}
    >
      <div className="scheduled-work-scroll">
        <div className="scheduled-work-content">
          <header className="scheduled-work-header">
            <div
              aria-label="Workflow view"
              className="scheduled-view-tabs"
              role="tablist"
            >
              <button
                aria-selected={viewMode === "calendar"}
                className={viewMode === "calendar" ? "active" : undefined}
                onClick={() => selectViewMode("calendar")}
                role="tab"
                type="button"
              >
                Calendar
              </button>
              <button
                aria-selected={viewMode === "list"}
                className={viewMode === "list" ? "active" : undefined}
                onClick={() => selectViewMode("list")}
                role="tab"
                type="button"
              >
                List
              </button>
            </div>
            <div className="scheduled-work-header-actions">
              <button
                aria-label="Refresh schedules"
                className="scheduled-icon-button"
                disabled={!connection || savedWork.loading || localSchedules.loading || chatWorkflows.loading}
                onClick={() => void refreshSchedules()}
                title="Refresh schedules"
                type="button"
              >
                <RefreshCw
                  className={
                    manualRefreshing
                      ? "scheduled-spin"
                      : undefined
                  }
                  size={16}
                />
              </button>
              <label className="scheduled-filter">
                <ListFilter aria-hidden="true" size={16} />
                <select
                  aria-label="Schedule filter"
                  onChange={(event) =>
                    setFilter(event.target.value as ScheduleFilter)
                  }
                  value={filter}
                >
                  <option value="active">Active</option>
                  <option value="paused">Paused</option>
                  <option value="all">All</option>
                </select>
              </label>
            </div>
          </header>

          <section
            aria-busy={savedWork.loading || localSchedules.loading || chatWorkflows.loading}
            className="scheduled-list"
          >
            {!connection ? (
              <EmptyMessage>Connect to OpenPond to view scheduled Work.</EmptyMessage>
            ) : (savedWork.loading || localSchedules.loading || chatWorkflows.loading) &&
              rows.length === 0 &&
              localSchedules.schedules.length === 0 &&
              chatWorkflows.workflows.length === 0 ? (
              <LoadingMessage label="Loading schedules" />
            ) : savedWork.error &&
              localSchedules.error &&
              rows.length === 0 &&
              localSchedules.schedules.length === 0 ? (
              <EmptyMessage>Schedules are unavailable. Refresh to try again.</EmptyMessage>
            ) : combinedRows.length === 0 ? (
              <EmptyMessage>Create a scheduled task here or ask for one in Work.</EmptyMessage>
            ) : viewMode === "calendar" ? (
              <ScheduledWorkCalendar
                items={calendarItems}
                onSelect={selectSchedule}
                selectedKey={selectedScheduleKey}
              />
            ) : (
              <div className="scheduled-list-rows">
                {combinedRows.map((item) =>
                  item.kind === "chat" ? (
                    <ChatWorkflowRow
                      cadence={recurrenceCadence(item.workflow.recurrence)}
                      key={chatWorkflowKey(item.workflow.id)}
                      onSelect={() => selectSchedule(chatWorkflowKey(item.workflow.id))}
                      selected={selectedScheduleKey === chatWorkflowKey(item.workflow.id)}
                      workflow={item.workflow}
                    />
                  ) : item.kind === "local" ? (
                    <LocalScheduleRow
                      cadence={localScheduleCadence(item.schedule)}
                      key={localScheduleKey(item.schedule.id)}
                      onSelect={() =>
                        selectSchedule(localScheduleKey(item.schedule.id))
                      }
                      schedule={item.schedule}
                      selected={
                        selectedScheduleKey === localScheduleKey(item.schedule.id)
                      }
                    />
                  ) : (
                    <HostedScheduleRow
                      cadence={scheduleCadence(item.row.schedule)}
                      definition={item.row.definition}
                      key={hostedScheduleKey(item.row.schedule.id)}
                      onSelect={() =>
                        selectSchedule(hostedScheduleKey(item.row.schedule.id))
                      }
                      schedule={item.row.schedule}
                      selected={
                        selectedScheduleKey === hostedScheduleKey(item.row.schedule.id)
                      }
                    />
                  )
                )}
              </div>
            )}
          </section>
        </div>
      </div>

      {selectedHosted ? (
        <ScheduleDetail
          key={`${selectedHosted.schedule.id}:${selectedHosted.definition.version}:${selectedHosted.schedule.configurationVersion}`}
          onClose={closeDetail}
          onDelete={async () => {
            await savedWork.remove(selectedHosted.schedule.id);
            closeDetail();
          }}
          onRun={() => savedWork.run(selectedHosted.schedule.id)}
          onSave={(input) => savedWork.update(selectedHosted.schedule.id, input)}
          onToggle={() =>
            savedWork.update(selectedHosted.schedule.id, {
              enabled: !selectedHosted.schedule.enabled,
            })
          }
          pending={savedWork.pendingScheduleIds.has(selectedHosted.schedule.id)}
          row={selectedHosted}
          runs={selectedRuns}
          detailExpanded={detailExpanded}
          onDetailResizeStart={onDetailResizeStart}
          onToggleDetailExpanded={onToggleDetailExpanded}
          webBaseUrl={savedWork.webBaseUrl}
        />
      ) : selectedChat ? (
        <ChatWorkflowDetail
          detailExpanded={detailExpanded}
          key={selectedChat.id}
          onClose={closeDetail}
          onDelete={async () => {
            await chatWorkflows.remove(selectedChat.id);
            closeDetail();
          }}
          onDetailResizeStart={onDetailResizeStart}
          onRun={() => chatWorkflows.run(selectedChat.id)}
          onToggle={() =>
            chatWorkflows.update(selectedChat.id, {
              enabled: !selectedChat.enabled,
            })
          }
          onToggleDetailExpanded={onToggleDetailExpanded}
          pending={chatWorkflows.pendingIds.has(selectedChat.id)}
          runs={chatWorkflows.runs.filter((run) => run.workflowId === selectedChat.id)}
          workflow={selectedChat}
        />
      ) : selectedLocal ? (
        <LocalScheduleDetail
          connection={connection}
          key={selectedLocal.id}
          onClose={closeDetail}
          onRun={() => localSchedules.run(selectedLocal)}
          onToggle={() => localSchedules.toggle(selectedLocal)}
          pending={localSchedules.pendingScheduleIds.has(selectedLocal.id)}
          schedule={selectedLocal}
          detailExpanded={detailExpanded}
          onDetailResizeStart={onDetailResizeStart}
          onToggleDetailExpanded={onToggleDetailExpanded}
        />
      ) : null}
    </section>
  );
}

function LocalScheduleDetail({
  connection,
  detailExpanded,
  onClose,
  onDetailResizeStart,
  onRun,
  onToggleDetailExpanded,
  onToggle,
  pending,
  schedule,
}: {
  connection: ClientConnection | null;
  detailExpanded: boolean;
  onClose: () => void;
  onDetailResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onRun: () => Promise<void>;
  onToggleDetailExpanded: () => void;
  onToggle: () => Promise<void>;
  pending: boolean;
  schedule: LocalAgentSchedule;
}) {
  const runs = useLocalScheduleRuns(connection, schedule.id);
  useErrorToast(runs.error, { prefix: "Local schedule runs" });
  return (
    <ScheduleDetailPanel
      detailExpanded={detailExpanded}
      label={`${schedule.scheduleName} details`}
      onClose={onClose}
      onDetailResizeStart={onDetailResizeStart}
      onToggleDetailExpanded={onToggleDetailExpanded}
    >
      <div className="scheduled-detail-header">
        <div>
          <div className="scheduled-detail-title-row">
            <h2>Schedule details</h2>
            <span>{schedule.enabled ? "Active" : "Paused"}</span>
          </div>
          <p>{schedule.scheduleName}</p>
        </div>
      </div>
      <DetailSection title="Task">
        <dl className="scheduled-detail-fields">
          <DetailField label="Environment" value="Local" />
          <DetailField label="Project" value={schedule.localProjectName} />
          <DetailField label="Agent" value={schedule.agentName} />
          <DetailField label="Action" value={schedule.targetAction} />
        </dl>
        <pre className="scheduled-prompt">{localScheduleInput(schedule)}</pre>
      </DetailSection>
      <DetailSection title="Schedule">
        <dl className="scheduled-detail-fields">
          <DetailField label="Cadence" value={localScheduleCadence(schedule)} />
          <DetailField label="Expression" value={schedule.scheduleExpression} />
          <DetailField label="Timezone" value={schedule.timezone ?? "Local time"} />
          <DetailField
            label="Next run"
            value={formatScheduledRunAt(schedule.nextRunAt, schedule.timezone)}
          />
          <DetailField
            label="Last run"
            value={formatScheduledRunAt(schedule.lastRunAt, schedule.timezone)}
          />
        </dl>
        {schedule.lastError ? (
          <p className="scheduled-detail-error">{schedule.lastError}</p>
        ) : null}
      </DetailSection>
      <div className="scheduled-detail-actions">
        <button disabled={pending} onClick={() => void onRun()} type="button">
          <RotateCcw size={15} />
          <span>Run now</span>
        </button>
        <button disabled={pending} onClick={() => void onToggle()} type="button">
          {schedule.enabled ? <Pause size={15} /> : <Play size={15} />}
          <span>{schedule.enabled ? "Pause" : "Resume"}</span>
        </button>
      </div>
      <DetailSection title="Runs">
        {runs.loading && runs.runs.length === 0 ? (
          <LoadingMessage label="Loading runs" />
        ) : runs.runs.length === 0 ? (
          <p className="scheduled-no-runs">No runs yet.</p>
        ) : (
          <div className="scheduled-run-list">
            {runs.runs.map((run) => (
              <LocalScheduleRunRow key={run.id} run={run} />
            ))}
          </div>
        )}
      </DetailSection>
    </ScheduleDetailPanel>
  );
}

function ScheduleDetail({
  detailExpanded,
  onClose,
  onDelete,
  onDetailResizeStart,
  onRun,
  onSave,
  onToggleDetailExpanded,
  onToggle,
  pending,
  row,
  runs,
  webBaseUrl,
}: {
  detailExpanded: boolean;
  onClose: () => void;
  onDelete: () => Promise<void>;
  onDetailResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onRun: () => Promise<void>;
  onSave: (input: {
    name: string;
    prompt: string;
    recurrence: SavedWorkRecurrence;
  }) => Promise<void>;
  onToggleDetailExpanded: () => void;
  onToggle: () => Promise<void>;
  pending: boolean;
  row: ScheduledRow;
  runs: HostedSavedWorkRun[];
  webBaseUrl: string | null;
}) {
  const recurrence = recurrenceForEditor(row.schedule);
  const [name, setName] = useState(row.definition.name);
  const [prompt, setPrompt] = useState(row.definition.prompt);
  const [frequency, setFrequency] = useState<Frequency>(recurrence.kind);
  const [timeZone, setTimeZone] = useState(recurrence.timeZone);
  const [startDate, setStartDate] = useState(recurrence.startDate);
  const [localTime, setLocalTime] = useState(recurrence.localTime);
  const [weekday, setWeekday] = useState<SavedWorkWeekday>(
    recurrence.weekdays?.[0] ?? "monday"
  );
  const [dayOfMonth, setDayOfMonth] = useState(recurrence.dayOfMonth ?? 1);
  const latestConversationId = runs[0]?.conversationId ?? null;
  const chatUrl = webBaseUrl
    ? hostedConversationUrl(webBaseUrl, latestConversationId)
    : null;
  const dirty =
    name !== row.definition.name ||
    prompt !== row.definition.prompt ||
    frequency !== recurrence.kind ||
    timeZone !== recurrence.timeZone ||
    startDate !== recurrence.startDate ||
    localTime !== recurrence.localTime ||
    weekday !== (recurrence.weekdays?.[0] ?? "monday") ||
    dayOfMonth !== (recurrence.dayOfMonth ?? 1);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSave({
      name,
      prompt,
      recurrence: {
        version: 1,
        kind: frequency,
        timeZone,
        startDate,
        localTime,
        end: { kind: "never" },
        ...(frequency === "weekly" ? { weekdays: [weekday] } : {}),
        ...(frequency === "monthly" ? { dayOfMonth } : {}),
      },
    });
  }

  return (
    <ScheduleDetailPanel
      detailExpanded={detailExpanded}
      label={`${row.definition.name} details`}
      onClose={onClose}
      onDetailResizeStart={onDetailResizeStart}
      onToggleDetailExpanded={onToggleDetailExpanded}
    >
      <form onSubmit={submit}>
        <div className="scheduled-detail-header">
          <div>
            <div className="scheduled-detail-title-row">
              <h2>Schedule details</h2>
              <span>{row.schedule.enabled ? "Active" : "Paused"}</span>
            </div>
          </div>
          <div className="scheduled-detail-header-controls">
            <button
              aria-label="Delete schedule"
              className="scheduled-icon-button"
              disabled={pending}
              onClick={() => void onDelete()}
              title="Delete schedule"
              type="button"
            >
              <Trash2 size={16} />
            </button>
          </div>
        </div>

        <DetailSection title="Task">
          <label className="scheduled-field">
            <span>Name</span>
            <input
              maxLength={180}
              onChange={(event) => setName(event.target.value)}
              required
              value={name}
            />
          </label>
          <label className="scheduled-field">
            <span>Prompt</span>
            <textarea
              onChange={(event) => setPrompt(event.target.value)}
              required
              value={prompt}
            />
          </label>
        </DetailSection>

        <DetailSection title="Schedule">
          <div className="scheduled-field-grid">
            <label className="scheduled-field">
              <span>Repeat</span>
              <select
                onChange={(event) => setFrequency(event.target.value as Frequency)}
                value={frequency}
              >
                <option value="once">Once</option>
                <option value="daily">Daily</option>
                <option value="weekdays">Weekdays</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
            </label>
            {frequency === "weekly" ? (
              <label className="scheduled-field">
                <span>Day</span>
                <select
                  onChange={(event) =>
                    setWeekday(event.target.value as SavedWorkWeekday)
                  }
                  value={weekday}
                >
                  {WEEKDAYS.map((day) => (
                    <option key={day} value={day}>
                      {capitalize(day)}
                    </option>
                  ))}
                </select>
              </label>
            ) : frequency === "monthly" ? (
              <label className="scheduled-field">
                <span>Day of month</span>
                <input
                  max={31}
                  min={1}
                  onChange={(event) => setDayOfMonth(Number(event.target.value))}
                  type="number"
                  value={dayOfMonth}
                />
              </label>
            ) : null}
            <label className="scheduled-field">
              <span>Start date</span>
              <input
                onChange={(event) => setStartDate(event.target.value)}
                required
                type="date"
                value={startDate}
              />
            </label>
            <label className="scheduled-field">
              <span>Time</span>
              <input
                onChange={(event) => setLocalTime(event.target.value)}
                required
                type="time"
                value={localTime}
              />
            </label>
            <label className="scheduled-field scheduled-field-wide">
              <span>Timezone</span>
              <input
                onChange={(event) => setTimeZone(event.target.value)}
                required
                value={timeZone}
              />
            </label>
          </div>
          <p className="scheduled-next-run">
            Next run: {formatScheduledRunAt(row.schedule.nextRunAt, recurrence.timeZone)}
          </p>
        </DetailSection>

        <div className="scheduled-detail-actions">
          {dirty ? (
            <button disabled={pending} type="submit">
              <Save size={15} />
              <span>Save</span>
            </button>
          ) : null}
          <button disabled={pending} onClick={() => void onRun()} type="button">
            <RotateCcw size={15} />
            <span>Run now</span>
          </button>
          <button disabled={pending} onClick={() => void onToggle()} type="button">
            {row.schedule.enabled ? <Pause size={15} /> : <Play size={15} />}
            <span>{row.schedule.enabled ? "Pause" : "Resume"}</span>
          </button>
        </div>
        <button
          className="scheduled-open-chat"
          disabled={pending || !chatUrl}
          onClick={() => {
            if (chatUrl) void openExternalUrl(chatUrl, latestConversationId);
          }}
          type="button"
        >
          <span>Open hosted chat</span>
          <ExternalLink size={14} />
        </button>

        <DetailSection title="Runs">
          {runs.length === 0 ? (
            <p className="scheduled-no-runs">No runs yet.</p>
          ) : (
            <div className="scheduled-run-list">
              {runs.map((run) => (
                <ScheduleRunRow
                  key={run.id}
                  onOpen={() => {
                    if (webBaseUrl) {
                      void openExternalUrl(
                        hostedConversationUrl(webBaseUrl, run.conversationId),
                        run.conversationId
                      );
                    }
                  }}
                  run={run}
                />
              ))}
            </div>
          )}
        </DetailSection>
      </form>
    </ScheduleDetailPanel>
  );
}

export function scheduledRows(
  definitions: HostedSavedWorkDefinition[]
): ScheduledRow[] {
  return definitions.flatMap((definition) =>
    definition.schedules.map((schedule) => ({ definition, schedule }))
  );
}

export function filterAndSortSchedules(
  rows: ScheduledRow[],
  filter: ScheduleFilter
): ScheduledRow[] {
  return rows
    .filter((row) => {
      if (filter === "active") return row.schedule.enabled;
      if (filter === "paused") return !row.schedule.enabled;
      return true;
    })
    .sort((left, right) => {
      const timeDifference =
        scheduleTime(left.schedule.nextRunAt) -
        scheduleTime(right.schedule.nextRunAt);
      return timeDifference || left.definition.name.localeCompare(right.definition.name);
    });
}

export function filterAndSortLocalSchedules(
  schedules: LocalAgentSchedule[],
  filter: ScheduleFilter
): LocalAgentSchedule[] {
  return schedules
    .filter((schedule) => {
      if (filter === "active") return schedule.enabled;
      if (filter === "paused") return !schedule.enabled;
      return true;
    })
    .sort((left, right) => {
      const timeDifference =
        scheduleTime(left.nextRunAt) - scheduleTime(right.nextRunAt);
      return timeDifference || left.scheduleName.localeCompare(right.scheduleName);
    });
}

export function combineScheduleRows(
  chatWorkflows: ChatWorkflow[],
  localSchedules: LocalAgentSchedule[],
  hostedRows: ScheduledRow[]
): CombinedScheduleRow[] {
  return [
    ...chatWorkflows.map((workflow) => ({ kind: "chat" as const, workflow })),
    ...localSchedules.map((schedule) => ({
      kind: "local" as const,
      schedule,
    })),
    ...hostedRows.map((row) => ({ kind: "hosted" as const, row })),
  ].sort((left, right) => {
    const leftTime = scheduleTime(scheduleRowNextRunAt(left));
    const rightTime = scheduleTime(scheduleRowNextRunAt(right));
    if (leftTime !== rightTime) return leftTime - rightTime;
    const leftName = scheduleRowName(left);
    const rightName = scheduleRowName(right);
    return leftName.localeCompare(rightName);
  });
}

function calendarItemForRow(item: CombinedScheduleRow): ScheduledCalendarItem {
  if (item.kind === "chat") {
    return {
      enabled: item.workflow.enabled,
      key: chatWorkflowKey(item.workflow.id),
      nextRunAt: item.workflow.nextRunAt,
      title: item.workflow.name,
    };
  }
  if (item.kind === "local") {
    return {
      enabled: item.schedule.enabled,
      key: localScheduleKey(item.schedule.id),
      nextRunAt: item.schedule.nextRunAt,
      title: item.schedule.scheduleName,
    };
  }
  return {
    enabled: item.row.schedule.enabled,
    key: hostedScheduleKey(item.row.schedule.id),
    nextRunAt: item.row.schedule.nextRunAt,
    title: item.row.definition.name,
  };
}

export function scheduleCadence(schedule: HostedSavedWorkSchedule): string {
  const recurrence = schedule.recurrence;
  if (!recurrence) return schedule.expression ?? "Manual";
  return recurrenceCadence(recurrence);
}

function scheduleRowNextRunAt(item: CombinedScheduleRow): string | null {
  if (item.kind === "chat") return item.workflow.nextRunAt;
  return item.kind === "local" ? item.schedule.nextRunAt : item.row.schedule.nextRunAt;
}

function scheduleRowName(item: CombinedScheduleRow): string {
  if (item.kind === "chat") return item.workflow.name;
  return item.kind === "local" ? item.schedule.scheduleName : item.row.definition.name;
}

export function localScheduleCadence(schedule: LocalAgentSchedule): string {
  const timeZone = schedule.timezone ? ` · ${schedule.timezone}` : "";
  if (schedule.scheduleType === "rate") {
    return `Every ${schedule.scheduleExpression}${timeZone}`;
  }
  const fields = schedule.scheduleExpression.trim().split(/\s+/);
  if (
    fields.length === 5 &&
    /^\d+$/.test(fields[0]!) &&
    /^\d+$/.test(fields[1]!)
  ) {
    const time = formatLocalTime(
      `${fields[1]!.padStart(2, "0")}:${fields[0]!.padStart(2, "0")}`
    );
    if (fields[2] === "*" && fields[3] === "*" && fields[4] === "*") {
      return `Daily at ${time}${timeZone}`;
    }
    if (
      fields[2] === "*" &&
      fields[3] === "*" &&
      fields[4] === "MON-FRI"
    ) {
      return `Weekdays at ${time}${timeZone}`;
    }
  }
  return `Cron ${schedule.scheduleExpression}${timeZone}`;
}

function recurrenceForEditor(
  schedule: HostedSavedWorkSchedule
): SavedWorkRecurrence {
  return (
    schedule.recurrence ?? {
      version: 1,
      kind: "daily",
      timeZone: schedule.timeZone || localTimeZone(),
      startDate: todayDate(),
      localTime: "08:00",
      end: { kind: "never" },
    }
  );
}

function localScheduleInput(schedule: LocalAgentSchedule): string {
  const prompt = schedule.input.prompt;
  if (typeof prompt === "string" && prompt.trim()) return prompt.trim();
  return Object.keys(schedule.input).length > 0
    ? JSON.stringify(schedule.input, null, 2)
    : "No task input configured.";
}

function useLocalScheduleRuns(
  connection: ClientConnection | null,
  scheduleId: string
) {
  const [runs, setRuns] = useState<LocalAgentScheduleRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!connection) {
      setRuns([]);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void api
      .localAgentScheduleRuns(connection, scheduleId, { limit: 20 })
      .then((payload) => {
        if (!cancelled) {
          setRuns(payload.runs);
          setError(null);
        }
      })
      .catch((caught) => {
        if (!cancelled) setError(errorMessage(caught));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connection, scheduleId]);

  return { error, loading, runs };
}

function localScheduleKey(scheduleId: string): string {
  return `local:${scheduleId}`;
}

function chatWorkflowKey(workflowId: string): string {
  return `chat:${workflowId}`;
}

function hostedScheduleKey(scheduleId: string): string {
  return `hosted:${scheduleId}`;
}

export function hostedConversationUrl(
  webBaseUrl: string,
  conversationId: string | null
): string {
  const baseUrl = new URL(webBaseUrl);
  baseUrl.pathname = conversationId
    ? `/sandboxes/work/${encodeURIComponent(conversationId)}`
    : "/sandboxes/work";
  baseUrl.search = "";
  baseUrl.hash = "";
  return baseUrl.toString();
}

async function openExternalUrl(
  url: string,
  conversationId: string | null
): Promise<void> {
  const browser = window.openpond?.browser;
  if (browser?.openExternal) {
    const result = await browser.openExternal({
      conversationId: conversationId ?? "hosted-scheduled-work",
      url,
    });
    if (result.ok) return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

function scheduleTime(value: string | null): number {
  if (!value) return Number.MAX_SAFE_INTEGER;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER;
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
