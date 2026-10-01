import { contentHash } from "@openpond/harness";
import { OpenPondTasksetCatalogClient } from "openpond-sdk/taskset-catalog";
import type { ExperimentEvaluationSchedule } from "openpond-sdk/experiment-evaluation-schedules";
/** Metadata observation never retargets a saved recipe or launches evaluation. */
export function createScheduledDatasetReleaseReader(deps: {
  identity(): Promise<{ actorId: string; teamId: string }>;
  resolveAccess(): Promise<{ apiBaseUrl: string; token: string }>;
}) {
  return async (
    configuration: ExperimentEvaluationSchedule["configuration"],
  ) => {
    const actor = await deps.identity(),
      access = await deps.resolveAccess();
    if (actor.teamId !== configuration.request.teamId)
      throw new Error("The schedule Dataset workspace changed.");
    const client = new OpenPondTasksetCatalogClient({
        apiKey: access.token,
        baseUrl: access.apiBaseUrl,
        teamId: actor.teamId,
      }),
      selected = configuration.request.taskset;
    let newer: { id: string; revision: number; contentHash: string } | null =
        null,
      cursor: string | undefined;
    const seen = new Set<string>();
    do {
      if (cursor && seen.has(cursor))
        throw new Error("Dataset catalog continuation repeated.");
      if (cursor) seen.add(cursor);
      const page = await client.list({
        afterId: cursor,
        limit: 100,
        ...(configuration.request.project
          ? { projectId: configuration.request.project.id }
          : {}),
      });
      for (const row of page.items)
        if (
          row.release.id === selected.id &&
          row.release.revision > selected.revision &&
          (!newer || row.release.revision > newer.revision)
        )
          newer = row.release;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    const next = await deps.resolveAccess();
    if (
      contentHash(await deps.identity()) !== contentHash(actor) ||
      next.apiBaseUrl !== access.apiBaseUrl ||
      next.token !== access.token
    )
      throw new Error(
        "The schedule Dataset connection changed during observation.",
      );
    return newer;
  };
}
