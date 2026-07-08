import type {
  DesktopHarnessApi,
  DesktopHarnessEvents,
  DesktopHarnessRuntimeEvent,
} from "./types.js";
import { waitFor } from "./cdp.js";

export class DesktopHarnessEventWaiter implements DesktopHarnessEvents {
  constructor(
    private readonly api: DesktopHarnessApi,
    private readonly defaultTimeoutMs: number,
    private readonly recordEvent: (event: DesktopHarnessRuntimeEvent) => void,
  ) {}

  async waitFor(
    predicate: (event: DesktopHarnessRuntimeEvent) => boolean,
    label: string,
    options: { timeoutMs?: number; sessionId?: string } = {},
  ): Promise<DesktopHarnessRuntimeEvent> {
    const event = await waitFor(async () => {
      const events = await this.loadEvents(options.sessionId);
      return events.find(predicate) ?? null;
    }, options.timeoutMs ?? this.defaultTimeoutMs, `Timed out waiting for ${label}.`);
    this.recordEvent(event);
    return event;
  }

  waitForName(
    sessionId: string,
    name: string,
    options: { timeoutMs?: number } = {},
  ): Promise<DesktopHarnessRuntimeEvent> {
    return this.waitFor(
      (event) => event.sessionId === sessionId && event.name === name,
      `${name} in ${sessionId}`,
      { ...options, sessionId },
    );
  }

  waitForToolCompleted(
    sessionId: string,
    action: string,
    options: { timeoutMs?: number } = {},
  ): Promise<DesktopHarnessRuntimeEvent> {
    return this.waitFor(
      (event) =>
        event.sessionId === sessionId &&
        event.name === "tool.completed" &&
        event.action === action &&
        (event.status === undefined || event.status === "completed"),
      `tool.completed:${action} in ${sessionId}`,
      { ...options, sessionId },
    );
  }

  waitForSubagentCompleted(
    sessionId: string,
    runId: string,
    options: { timeoutMs?: number } = {},
  ): Promise<DesktopHarnessRuntimeEvent> {
    return this.waitFor(
      (event) =>
        event.sessionId === sessionId &&
        event.name === "subagent.completed" &&
        event.data?.run &&
        typeof event.data.run === "object" &&
        !Array.isArray(event.data.run) &&
        (event.data.run as Record<string, unknown>).id === runId,
      `subagent.completed:${runId} in ${sessionId}`,
      { ...options, sessionId },
    );
  }

  private async loadEvents(sessionId?: string): Promise<DesktopHarnessRuntimeEvent[]> {
    const bootstrap = await this.api.bootstrap<{ events?: DesktopHarnessRuntimeEvent[] }>();
    const events = bootstrap.events ?? [];
    return sessionId ? events.filter((event) => event.sessionId === sessionId) : events;
  }
}

export function eventLabel(event: DesktopHarnessRuntimeEvent): string {
  const name = event.name ?? "event";
  if (name === "tool.completed" && event.action) return `${name}:${event.action}`;
  return name;
}
