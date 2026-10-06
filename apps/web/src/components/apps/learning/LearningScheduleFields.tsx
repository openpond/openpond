import type { DraftFieldsProps } from "./LearningSourcesFields";

const time = (hour: number | undefined, minute: number | undefined) =>
  hour === undefined || minute === undefined
    ? ""
    : `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
export function LearningScheduleFields({ draft, onChange }: DraftFieldsProps) {
  const setLimit = (key: keyof typeof draft.limits, value: number) =>
    onChange({ ...draft, limits: { ...draft.limits, [key]: value } });
  return (
    <>
      <fieldset>
        <legend>Run window</legend>
        <div className="agent-learning-columns">
          <label>
            From
            <input
              type="time"
              required
              value={time(draft.schedule.hour, draft.schedule.minute)}
              onChange={(event) => {
                const [hour, minute] = event.target.value.split(":").map(Number);
                onChange({
                  ...draft,
                  schedule: { ...draft.schedule, hour: hour!, minute: minute! },
                });
              }}
            />
          </label>
          <label>
            Until
            <input
              type="time"
              value={time(draft.schedule.endHour, draft.schedule.endMinute)}
              onChange={(event) => {
                const [endHour, endMinute] = event.target.value.split(":").map(Number);
                const { endHour: _hour, endMinute: _minute, ...rest } = draft.schedule;
                onChange({
                  ...draft,
                  schedule: event.target.value ? { ...rest, endHour, endMinute } : rest,
                });
              }}
            />
          </label>
        </div>
        <label>
          Timezone
          <input
            required
            value={draft.schedule.timezone}
            onChange={(event) =>
              onChange({ ...draft, schedule: { ...draft.schedule, timezone: event.target.value } })
            }
          />
        </label>
        <p>
          Queued learning starts within this window. A run already started may finish afterward.
        </p>
      </fieldset>
      <fieldset>
        <legend>Maximum spending</legend>
        <p>
          These are limits, not prices. Evaluation, answer improvements and training count toward
          them.
        </p>
        <div className="agent-learning-columns">
          {(
            [
              ["perCycleUsd", "Per run ($)"],
              ["dailyUsd", "Per day ($)"],
              ["monthlyUsd", "Per month ($)"],
            ] as const
          ).map(([key, label]) => (
            <label key={key}>
              {label}
              <input
                type="number"
                required
                min={0.01}
                max={100000}
                step={0.01}
                value={draft.limits[key]}
                onChange={(event) => setLimit(key, Number(event.target.value))}
              />
            </label>
          ))}
        </div>
      </fieldset>
      <details>
        <summary>Advanced limits</summary>
        <div className="agent-learning-columns">
          {(
            [
              ["gradeUsd", "Per evaluation ceiling ($)", 0, 1000, 0.01],
              ["maximumTasks", "Maximum tasks", 1, 200, 1],
              ["minimumExamples", "Minimum training examples", 1, 200, 1],
              ["maximumAttempts", "Maximum correction attempts", 1, 5, 1],
              ["lookbackDays", "Uploaded history window (days)", 1, 30, 1],
            ] as const
          ).map(([key, label, min, max, step]) => (
            <label key={key}>
              {label}
              <input
                type="number"
                required
                min={min}
                max={max}
                step={step}
                value={draft.limits[key]}
                onChange={(event) => setLimit(key, Number(event.target.value))}
              />
            </label>
          ))}
          <label>
            Maximum GPU session (hours)
            <input
              type="number"
              required
              min={0.01}
              max={3}
              step={0.01}
              value={draft.limits.maxGpuSeconds / 3600}
              onChange={(event) =>
                setLimit("maxGpuSeconds", Math.round(Number(event.target.value) * 3600))
              }
            />
          </label>
          <label>
            Pause after failed cycles
            <input
              type="number"
              required
              min={1}
              max={20}
              value={draft.failurePolicy?.pauseAfterConsecutiveFailures ?? 3}
              onChange={(event) =>
                onChange({
                  ...draft,
                  failurePolicy: { pauseAfterConsecutiveFailures: Number(event.target.value) },
                })
              }
            />
          </label>
        </div>
        <label className="agent-learning-check">
          <input
            type="checkbox"
            checked={draft.exceptions === "eligible_remainder"}
            onChange={(event) =>
              onChange({
                ...draft,
                exceptions: event.target.checked ? "eligible_remainder" : "block",
              })
            }
          />
          Use the independently verified remainder when exceptions occur
        </label>
      </details>
      <details>
        <summary>Training data balance</summary>
        <div className="agent-learning-columns">
          {(
            [
              ["maximumSourceShare", "Maximum from one agent", 100],
              ["maximumFailureShare", "Maximum from one error type", 100],
              ["maximumLengthShare", "Maximum from one conversation length", 100],
              ["replayFraction", "Previously learned examples", 50],
              ["auditFraction", "Examples checked for quality", 100],
            ] as const
          ).map(([key, label, max]) => (
            <label key={key}>
              {label} (%)
              <input
                type="number"
                min={key.startsWith("maximum") ? 1 : 0}
                max={max}
                value={Math.round((draft.selection?.[key] ?? 0) * 100)}
                onChange={(event) =>
                  onChange({
                    ...draft,
                    selection: {
                      maximumSourceShare: 1,
                      maximumFailureShare: 1,
                      maximumLengthShare: 1,
                      replayFraction: 0.2,
                      auditFraction: 0.1,
                      ...draft.selection,
                      [key]: Number(event.target.value) / 100,
                    },
                  })
                }
              />
            </label>
          ))}
        </div>
      </details>
      {draft.mode !== "evaluate" ? (
        <details>
          <summary>Checks before using the trained model</summary>
          <div className="agent-learning-columns">
            {(
              [
                ["windowCasesPerCheck", "New examples per quality check", 2, 10000],
                ["minimumCasesPerCheck", "Minimum paired examples", 2, 10000],
                ["minimumImprovement", "Required improvement", 0.0001, 1],
              ] as const
            ).map(([key, label, min, max]) => (
              <label key={key}>
                {label}
                <input
                  type="number"
                  min={min}
                  max={max}
                  step={key === "minimumImprovement" ? 0.01 : 1}
                  value={draft.acceptance?.[key] ?? min}
                  onChange={(event) =>
                    onChange({
                      ...draft,
                      acceptance: {
                        minimumCasesPerCheck: 20,
                        windowCasesPerCheck: 20,
                        minimumImprovement: 0.05,
                        ...draft.acceptance,
                        [key]: Number(event.target.value),
                      },
                    })
                  }
                />
              </label>
            ))}
          </div>
          <p>
            Current and trained models use the same unseen examples. Insufficient evidence keeps the
            current model active.
          </p>
        </details>
      ) : null}
    </>
  );
}
