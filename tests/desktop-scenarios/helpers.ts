import type { RuntimeEvent } from "@openpond/contracts";

import type { DesktopHarness } from "../../scripts/desktop-harness/types";

export type ChatModelRef = {
  providerId: "openpond";
  modelId: string;
};

export async function registerScriptedOpenPondModel(
  harness: DesktopHarness,
  modelRef: ChatModelRef,
): Promise<void> {
  await harness.api.fetchJson("/v1/providers", {
    method: "PATCH",
    body: {
      providers: {
        openpond: {
          enabled: true,
          defaultModel: modelRef.modelId,
          modelOverrides: [modelRef.modelId],
        },
      },
    },
  });
}

export async function configureResearchSubagentModel(
  harness: DesktopHarness,
  modelRef: ChatModelRef,
  options: { heartbeatIntervalSeconds?: number } = {},
): Promise<void> {
  await harness.api.fetchJson("/v1/preferences", {
    method: "PATCH",
    body: {
      subagents: {
        enabled: true,
        defaultModelRef: modelRef,
        ...(options.heartbeatIntervalSeconds ? { heartbeatIntervalSeconds: options.heartbeatIntervalSeconds } : {}),
        roles: [
          {
            id: "research",
            modelRef,
            toolPolicy: "read_only",
            background: true,
            peerMessages: "goal_scoped",
          },
        ],
      },
    },
  });
}

export async function configureCodingSubagentModel(
  harness: DesktopHarness,
  modelRef: ChatModelRef,
): Promise<void> {
  await harness.api.fetchJson("/v1/preferences", {
    method: "PATCH",
    body: {
      subagents: {
        enabled: true,
        defaultModelRef: modelRef,
        roles: [
          {
            id: "coding",
            modelRef,
            isolationMode: "copy_on_write",
            toolPolicy: "workspace_write",
            background: true,
            peerMessages: "goal_scoped",
          },
        ],
      },
    },
  });
}

export async function reloadRenderer(harness: DesktopHarness): Promise<void> {
  try {
    await harness.renderer.evaluate("window.location.reload(); true");
  } catch {
    // CDP may report an execution-context reset during reload; subsequent waits prove readiness.
  }
}

export async function waitForAssistantOutput(
  harness: DesktopHarness,
  sessionId: string,
  output: string,
  label: string,
): Promise<RuntimeEvent> {
  return await harness.events.waitFor(
    (event) =>
      event.sessionId === sessionId &&
      event.name === "assistant.delta" &&
      typeof event.output === "string" &&
      event.output.includes(output),
    label,
    { sessionId },
  ) as RuntimeEvent;
}

export async function waitForCompletedTurn(
  harness: DesktopHarness,
  sessionId: string,
  sourceEvent: RuntimeEvent,
  label: string,
): Promise<RuntimeEvent> {
  return await harness.events.waitFor(
    (event) =>
      event.sessionId === sessionId &&
      event.turnId === sourceEvent.turnId &&
      event.name === "turn.completed" &&
      event.status === "completed",
    label,
    { sessionId },
  ) as RuntimeEvent;
}

export async function waitForRendererCondition(
  harness: DesktopHarness,
  expression: string,
  label: string,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? harness.timeoutMs;
  const intervalMs = options.intervalMs ?? 250;
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      if (await harness.renderer.evaluate<boolean>(expression)) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(lastError ? `Timed out waiting for ${label}. Last error: ${String(lastError)}` : `Timed out waiting for ${label}.`);
}

export async function expandChildSessionGroup(
  harness: DesktopHarness,
  parentSessionId: string,
): Promise<void> {
  const selector = JSON.stringify(`[data-session-id="${parentSessionId}"]`);
  await waitForRendererCondition(
    harness,
    `(() => {
      const row = document.querySelector(${selector});
      if (!(row instanceof HTMLElement)) return false;
      const toggle = row.querySelector('.sidebar-child-toggle');
      if (!(toggle instanceof HTMLButtonElement)) return false;
      if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
      return true;
    })()`,
    `child session group for ${parentSessionId}`,
  );
}

export async function waitForSidebarSessionRow(
  harness: DesktopHarness,
  sessionId: string,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  const selector = JSON.stringify(`[data-session-id="${sessionId}"]`);
  await waitForRendererCondition(
    harness,
    `Boolean(document.querySelector(${selector}))`,
    `sidebar session row for ${sessionId}`,
    options,
  );
}

export function toolResultFromEvent(event: RuntimeEvent): Record<string, unknown> | null {
  const data = asRecord(event.data);
  return asRecord(data?.result);
}

export function stringFromRecord(record: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
