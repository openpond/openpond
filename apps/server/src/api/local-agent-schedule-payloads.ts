import type { createLocalAgentScheduleLoop } from "../agents/local-agent-scheduler.js";

export function createLocalAgentSchedulePayloads(
  localAgentScheduleLoop: ReturnType<typeof createLocalAgentScheduleLoop>
) {
  async function listLocalAgentSchedulesPayload(
    payload?: unknown
  ): Promise<unknown> {
    const input =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as { localProjectId?: unknown })
        : {};
    return localAgentScheduleLoop.list({
      localProjectId:
        typeof input.localProjectId === "string" ? input.localProjectId : null,
    });
  }

  async function syncLocalAgentSchedulesPayload(): Promise<unknown> {
    return localAgentScheduleLoop.syncNow();
  }

  async function patchLocalAgentSchedulePayload(
    scheduleId: string,
    payload: unknown
  ): Promise<unknown> {
    const updated = await localAgentScheduleLoop.patchSchedule(
      scheduleId,
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as { enabled?: boolean })
        : {}
    );
    if (!updated) throw new Error("Local agent schedule not found");
    return { schedule: updated };
  }

  async function runLocalAgentSchedulePayload(
    scheduleId: string,
    payload: unknown
  ): Promise<unknown> {
    const input =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as { input?: unknown })
        : {};
    return localAgentScheduleLoop.runNow(
      scheduleId,
      input.input &&
        typeof input.input === "object" &&
        !Array.isArray(input.input)
        ? (input.input as Record<string, unknown>)
        : undefined
    );
  }

  async function listLocalAgentScheduleRunsPayload(
    scheduleId: string,
    payload?: unknown
  ): Promise<unknown> {
    const input =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as { limit?: unknown })
        : {};
    const limit = typeof input.limit === "number" ? input.limit : undefined;
    return { runs: await localAgentScheduleLoop.listRuns(scheduleId, limit) };
  }

  return {
    listLocalAgentSchedulesPayload,
    syncLocalAgentSchedulesPayload,
    patchLocalAgentSchedulePayload,
    runLocalAgentSchedulePayload,
    listLocalAgentScheduleRunsPayload,
  };
}
