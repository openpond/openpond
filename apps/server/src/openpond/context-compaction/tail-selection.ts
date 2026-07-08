import type { RuntimeEvent } from "@openpond/contracts";
import { textFromUnknown } from "../../utils.js";
import { usableHostedContextLimit } from "../context-usage.js";
import { estimateTextTokens } from "./metrics.js";

export type HostedCompactionEventSelection = {
  summaryEvents: RuntimeEvent[];
  preservedEvents: RuntimeEvent[];
  preservedEventIds: string[];
  retainedTailTokens: number;
  retainedTailBudgetTokens: number;
  splitTurnId: string | null;
};

type EventUnit = {
  startIndex: number;
  endIndex: number;
  turnId: string | null;
  events: RuntimeEvent[];
  tokenEstimate: number;
};

export function selectEventsForHostedCompaction(
  events: readonly RuntimeEvent[],
  maxContextTokens: number,
): HostedCompactionEventSelection {
  const units = turnUnits(events);
  if (units.length === 0) {
    return {
      summaryEvents: [...events],
      preservedEvents: [],
      preservedEventIds: [],
      retainedTailTokens: 0,
      retainedTailBudgetTokens: retainedTailBudget(maxContextTokens),
      splitTurnId: null,
    };
  }

  const budget = retainedTailBudget(maxContextTokens);
  const selectedIds = new Set<string>();
  let retainedTailTokens = 0;
  let splitTurnId: string | null = null;

  for (let index = units.length - 1; index >= 0; index -= 1) {
    const unit = units[index]!;
    const isLatestTurn = index === units.length - 1;
    if (index === 0 && retainedTailTokens > 0) break;
    if (retainedTailTokens + unit.tokenEstimate <= budget) {
      selectUnit(unit, selectedIds);
      retainedTailTokens += unit.tokenEstimate;
      continue;
    }

    if (isLatestTurn) {
      const split = selectOversizedLatestTurn(unit, Math.max(1, budget - retainedTailTokens));
      for (const event of split.events) selectedIds.add(event.id);
      retainedTailTokens += split.tokenEstimate;
      splitTurnId = unit.turnId;
    }
    break;
  }

  selectRecentFailures(units, selectedIds);
  const preservedEvents = events.filter((item) => selectedIds.has(item.id));
  const summaryEvents = events.filter((item) => !selectedIds.has(item.id));
  const finalRetainedTailTokens = preservedEvents.reduce((total, event) => total + estimateEventTokens(event), 0);

  return {
    summaryEvents,
    preservedEvents,
    preservedEventIds: preservedEvents.map((item) => item.id),
    retainedTailTokens: finalRetainedTailTokens,
    retainedTailBudgetTokens: budget,
    splitTurnId,
  };
}

function retainedTailBudget(maxContextTokens: number): number {
  const usable = usableHostedContextLimit(maxContextTokens);
  return Math.max(512, Math.min(32_000, Math.floor(usable * 0.25)));
}

function turnUnits(events: readonly RuntimeEvent[]): EventUnit[] {
  const units: EventUnit[] = [];
  let currentStart = -1;

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.name !== "turn.started") continue;
    if (currentStart >= 0) units.push(unitFromRange(events, currentStart, index - 1));
    currentStart = index;
  }

  if (currentStart >= 0) units.push(unitFromRange(events, currentStart, events.length - 1));
  return units;
}

function unitFromRange(events: readonly RuntimeEvent[], startIndex: number, endIndex: number): EventUnit {
  const unitEvents = events.slice(startIndex, endIndex + 1);
  return {
    startIndex,
    endIndex,
    turnId: unitEvents[0]?.turnId ?? null,
    events: unitEvents,
    tokenEstimate: unitEvents.reduce((total, event) => total + estimateEventTokens(event), 0),
  };
}

function selectUnit(unit: EventUnit, selectedIds: Set<string>): void {
  for (const event of unit.events) selectedIds.add(event.id);
}

function selectOversizedLatestTurn(unit: EventUnit, budget: number): {
  events: RuntimeEvent[];
  tokenEstimate: number;
} {
  const selected = new Map<string, RuntimeEvent>();
  let tokens = 0;
  const first = unit.events[0];
  if (first) {
    selected.set(first.id, first);
    tokens += estimateEventTokens(first);
  }

  for (let index = unit.events.length - 1; index >= 1; index -= 1) {
    const event = unit.events[index]!;
    const eventTokens = estimateEventTokens(event);
    const shouldForceLatest = selected.size <= 1 && index === unit.events.length - 1;
    const shouldForceFailure = event.name === "turn.failed" || event.status === "failed";
    if (!shouldForceLatest && !shouldForceFailure && tokens + eventTokens > budget) continue;
    selected.set(event.id, event);
    tokens += eventTokens;
    if (tokens >= budget && selected.size > 1) break;
  }

  const events = unit.events.filter((event) => selected.has(event.id));
  return { events, tokenEstimate: events.reduce((total, event) => total + estimateEventTokens(event), 0) };
}

function selectRecentFailures(units: readonly EventUnit[], selectedIds: Set<string>): void {
  const recentUnits = units.slice(Math.max(0, units.length - 4));
  for (const unit of recentUnits) {
    const failedEvents = unit.events.filter(isFailureEvent);
    if (failedEvents.length === 0) continue;
    const turnStart = unit.events[0];
    if (turnStart) selectedIds.add(turnStart.id);
    for (const event of failedEvents) selectedIds.add(event.id);
  }
}

function isFailureEvent(event: RuntimeEvent): boolean {
  return event.name === "turn.failed" || event.status === "failed";
}

function estimateEventTokens(event: RuntimeEvent): number {
  const text = [
    event.name,
    event.action,
    event.status,
    event.output,
    event.error,
    event.args ? textFromUnknown(event.args) : null,
    event.data ? textFromUnknown(event.data) : null,
  ].filter(Boolean).join("\n");
  return Math.max(1, estimateTextTokens(text));
}
