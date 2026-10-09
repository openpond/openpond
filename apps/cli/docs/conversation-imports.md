# Conversation imports

An import runs once, shows progress in the terminal, and exits. Initial history defaults to the **last week**; interactive setup shows `Initial history: day, week, or all [default: week]`. Press Enter to accept it, or specify `--range day|week|all`.

**Continual imports default to off.** `--continual` explicitly enables recurring imports. `--daily`, `--weekly`, `--hourly`, and `--cron` select the cadence and require `--continual`; they do not select how much history to import. Continual imports do not enable continual learning or change model training schedules.

```sh
# Import the last week once; no recurring schedule is created.
openpond import --source codex

# Import once and enable daily imports at midnight local time.
openpond import --source codex --continual --daily

# Weekly imports default to Monday at midnight.
openpond import --source codex --continual --weekly

# Import hourly, at minute 00.
openpond import --source codex --continual --hourly


# Cron: hourly on weekdays from 9 a.m. through 5 p.m.
openpond import --source codex --continual --cron "0 9-17 * * mon-fri"

# Choose a weekday and time explicitly.
openpond import --source codex --range week --continual --weekly --on fri --at 01:00

# Set recurrence for an existing connection without starting an import.
openpond import schedule <connection-id> --continual --daily --at 00:00

# Disable recurrence without cancelling an import in progress.
openpond import schedule <connection-id> --off

# Inspect progress, connection IDs, errors and schedules.
openpond import status

# Run once now without changing the schedule.
openpond import sync <connection-id>

# Cancel the current job, keeping queued work and its schedule.
openpond import cancel
```

`--continual` alone defaults to daily at `00:00`. `--weekly` defaults to `--on mon`; supported weekdays are `sun|mon|tue|wed|thu|fri|sat`. Use `--at HH:MM` for the local start time. Choose only one cadence. `--at` applies to daily/weekly schedules, and `--on` applies to weekly schedules. For a custom hourly minute, use cron (for example, `15 * * * *`). Existing schedules stay unchanged when running a one-time import; use `schedule --off` to turn them off.

`--range` selects the initial history cutoff, independently of recurrence. Future jobs reconcile changes against retained source revisions and admission receipts, including changes made during missed days. `Ctrl+C` cancels a foreground job; it does not leave a background importer running.

In the desktop app, **Settings → Conversation imports** shows each source and destination, its initial cutoff, last successful sync, next run, progress and errors. Enable **Continual imports**, then choose **Hourly**, **Daily**, **Weekly**, or **Custom cron**, with weekday/time or expression when applicable. Defaults are daily at midnight, or Monday at midnight for weekly. Midnight leaves time before a 02:00 model run; import scheduling does not itself establish a training dependency.

Cron uses five fields: **minute hour day-of-month month day-of-week**. It supports numbers, `*`, comma lists, ranges, steps, month names and weekday names. When both day-of-month and day-of-week are restricted, either can match. Sunday can be `0` or `7`. Seconds, randomization and Quartz extensions (`L`, `#`, `?`) are not supported. The fastest supported cadence is hourly, with a single selected minute. Impossible calendars and invalid expressions are rejected before saving.

Schedules follow the computer's local timezone. The OS launches a bounded job at the selected time; no importer stays running between jobs. The machine is not woken. Runs missed while off or asleep are skipped, without catch-up at login. The next scheduled or manual job resumes retained work. A paused or disconnected source is not automatically resumed by its schedule.

Jobs stop after an hour or a persistent admission failure (at most three attempts for an operation per run). Pending uploads drain before acquiring more history. Errors and unacknowledged work are retained for the next scheduled or manual run. Changing a schedule never starts a job. If a scheduled tick occurs while an import is running, it is skipped rather than queued or overlapped. Cron uses a small, dependency-free calendar check each minute; the full importer is loaded only at matching times.

CLI and desktop share `~/.openpond/conversation-importer` by default, independently of the desktop application's home. Each connection retains the account-store location used to authorize it. For isolated environments, use `--collector-dir <absolute-path>` or `OPENPOND_COLLECTOR_DIR`; the desktop shows its exact directory under **CLI and local state**.

Cron expressions must select a single minute within each hour; sub-hourly imports are not supported. The 128 MiB local queue limit is not a network upload budget. Uploads currently contain full changed source files, so hourly syncing can still transfer substantial data.
