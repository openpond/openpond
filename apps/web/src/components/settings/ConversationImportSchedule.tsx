import { useState } from "react";
import type { CollectorSchedule } from "@openpond/evals/native-conversations";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
type Draft = { enabled: boolean; frequency: CollectorSchedule["frequency"]; time: string; day: number; expression: string };

export function ConversationImportSchedule({ schedule, name, disabled, disconnected, onSave }: {
  schedule: CollectorSchedule | null;
  name: string;
  disabled: boolean;
  disconnected: boolean;
  onSave(schedule: CollectorSchedule | null): Promise<void>;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const values = draft ?? {
    enabled: !!schedule, frequency: schedule?.frequency ?? "daily",
    time: schedule?.frequency === "daily" || schedule?.frequency === "weekly" ? schedule.time : "00:00",
    day: schedule?.frequency === "weekly" ? schedule.day : 1,
    expression: schedule?.frequency === "cron" ? schedule.expression : "0 * * * *",
  };
  const { enabled, frequency, time, day, expression } = values;
  const next: CollectorSchedule | null = !enabled ? null
    : frequency === "cron" ? { frequency, expression: expression.trim() }
    : frequency === "hourly" ? { frequency }
    : frequency === "weekly" ? { frequency, time, day } : { frequency, time };
  const changed = JSON.stringify(next) !== JSON.stringify(schedule);
  const fieldsDisabled = disabled || !enabled || disconnected;
  const timed = frequency === "daily" || frequency === "weekly";
  return <form className="conversation-import-schedule" onSubmit={event => {
    event.preventDefault();
    void onSave(next).then(() => setDraft(null)).catch(() => {});
  }}>
    <label><input type="checkbox" checked={enabled} disabled={disabled || (disconnected && !enabled)}
      onChange={event => setDraft({ ...values, enabled: event.target.checked })} />Continual imports</label>
    <label>Frequency<select aria-label={`${name} import frequency`} value={frequency} disabled={fieldsDisabled}
      onChange={event => setDraft({ ...values, frequency: event.target.value as CollectorSchedule["frequency"] })}>
      <option value="hourly">Hourly</option>
      <option value="daily">Daily</option><option value="weekly">Weekly</option><option value="cron">Custom cron</option>
    </select></label>
    {frequency === "weekly" ? <label>Day<select aria-label={`${name} import day`} value={day} disabled={fieldsDisabled}
      onChange={event => setDraft({ ...values, day: Number(event.target.value) })}>
      {WEEKDAYS.map((label, index) => <option key={label} value={index}>{label}</option>)}
    </select></label> : null}
    {timed ? <label>Sync time<input aria-label={`${name} sync time`} type="time" required={enabled} value={time}
      disabled={fieldsDisabled} onChange={event => setDraft({ ...values, time: event.target.value })} /></label> : null}
    {frequency === "cron" ? <label>Cron expression<input aria-label={`${name} cron expression`} type="text"
      required={enabled} maxLength={512} value={expression} placeholder="0 * * * *" disabled={fieldsDisabled}
      onChange={event => setDraft({ ...values, expression: event.target.value })} /></label> : null}
    <button className="settings-secondary" type="submit"
      disabled={disabled || !changed || (enabled && (timed ? !time : frequency === "cron" && !expression.trim()))}>
      {enabled ? "Save schedule" : "Disable continual imports"}
    </button>
    <small>{frequency === "cron" ? "Five fields: minute, hour, day of month, month, day of week. For example, 0 * * * * runs hourly. Choose a single minute; faster schedules are not supported. "
      : frequency === "hourly" ? "Runs at the start of each hour. "
      : "Midnight leaves time before a 2 a.m. model run. "}
      A running import is never overlapped. Changing this setting does not start an import.</small>
  </form>;
}
