import { useMemo, useState } from "react";
import { ArrowLeft, ArrowRight } from "../icons";

export type ScheduledCalendarItem = {
  enabled: boolean;
  key: string;
  nextRunAt: string | null;
  title: string;
};

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function ScheduledWorkCalendar({
  items,
  onSelect,
  selectedKey,
}: {
  items: ScheduledCalendarItem[];
  onSelect: (key: string) => void;
  selectedKey: string | null;
}) {
  const [visibleMonth, setVisibleMonth] = useState(() => monthStart(new Date()));
  const days = useMemo(() => calendarDays(visibleMonth), [visibleMonth]);
  const itemsByDay = useMemo(() => groupItemsByDay(items), [items]);
  const monthLabel = new Intl.DateTimeFormat(undefined, {
    month: "long",
    year: "numeric",
  }).format(visibleMonth);
  const unscheduled = items.filter((item) => !validDate(item.nextRunAt));

  return (
    <div className="scheduled-calendar">
      <div className="scheduled-calendar-toolbar">
        <strong>{monthLabel}</strong>
        <div>
          <button
            aria-label="Previous month"
            className="scheduled-icon-button"
            onClick={() => setVisibleMonth(addMonths(visibleMonth, -1))}
            type="button"
          >
            <ArrowLeft size={15} />
          </button>
          <button
            className="scheduled-calendar-today"
            onClick={() => setVisibleMonth(monthStart(new Date()))}
            type="button"
          >
            Today
          </button>
          <button
            aria-label="Next month"
            className="scheduled-icon-button"
            onClick={() => setVisibleMonth(addMonths(visibleMonth, 1))}
            type="button"
          >
            <ArrowRight size={15} />
          </button>
        </div>
      </div>
      <div className="scheduled-calendar-grid" role="grid" aria-label={monthLabel}>
        {WEEKDAY_LABELS.map((label) => (
          <div className="scheduled-calendar-weekday" key={label} role="columnheader">
            {label}
          </div>
        ))}
        {days.map((day) => {
          const key = dayKey(day);
          const dayItems = itemsByDay.get(key) ?? [];
          const outsideMonth = day.getMonth() !== visibleMonth.getMonth();
          const today = key === dayKey(new Date());
          return (
            <div
              className={`scheduled-calendar-day${outsideMonth ? " outside" : ""}${today ? " today" : ""}`}
              key={key}
              role="gridcell"
            >
              <span className="scheduled-calendar-day-number">{day.getDate()}</span>
              <div className="scheduled-calendar-events">
                {dayItems.map((item) => (
                  <button
                    aria-current={selectedKey === item.key ? "true" : undefined}
                    className={`scheduled-calendar-event${item.enabled ? "" : " paused"}`}
                    key={item.key}
                    onClick={() => onSelect(item.key)}
                    title={item.title}
                    type="button"
                  >
                    <span>{formatTime(item.nextRunAt!)}</span>
                    <strong>{item.title}</strong>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      {unscheduled.length ? (
        <div className="scheduled-calendar-unscheduled">
          <span>No upcoming run</span>
          <div>
            {unscheduled.map((item) => (
              <button key={item.key} onClick={() => onSelect(item.key)} type="button">
                {item.title}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function calendarDays(month: Date): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay());
  return Array.from({ length: 42 }, (_, index) => {
    const day = new Date(start);
    day.setDate(start.getDate() + index);
    return day;
  });
}

function groupItemsByDay(items: ScheduledCalendarItem[]): Map<string, ScheduledCalendarItem[]> {
  const grouped = new Map<string, ScheduledCalendarItem[]>();
  for (const item of items) {
    const date = validDate(item.nextRunAt);
    if (!date) continue;
    const key = dayKey(date);
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  }
  for (const dayItems of grouped.values()) {
    dayItems.sort((left, right) => left.nextRunAt!.localeCompare(right.nextRunAt!));
  }
  return grouped;
}

function validDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function monthStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addMonths(date: Date, amount: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + amount, 1);
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}
