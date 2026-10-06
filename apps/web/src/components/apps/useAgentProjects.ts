import { useCallback, useEffect, useState } from "react";
import type { AccountState } from "@openpond/contracts";
import {
  TrainingProjectListSchema,
  type TrainingProject,
} from "openpond-sdk/training-projects";
import { apiFetch, type ClientConnection } from "../../api/api-client";

type Entry = { projects: TrainingProject[]; selected: string };
const retained = new WeakMap<ClientConnection, Map<string, Entry>>();
export function useAgentProjects(
  connection: ClientConnection | null,
  account: AccountState | null,
  teamId: string | null,
) {
  const key = JSON.stringify([account?.activeProfile, account?.profile?.id, teamId]);
  const cached = connection ? retained.get(connection)?.get(key) : undefined;
  const [state, setState] = useState<{
    key: string;
    connection: ClientConnection;
    value: Entry;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const value = account?.state === "signed_in"
    ? state?.key === key && state.connection === connection ? state.value : cached
    : undefined;
  useEffect(() => {
    if (!connection || !teamId || account?.state !== "signed_in") return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    async function read() {
      const projects: TrainingProject[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = TrainingProjectListSchema.parse(
          await apiFetch(connection!, "/v1/training/evaluation-workspace", {
            method: "POST",
            body: JSON.stringify({
              teamId,
              operation: "projects",
              value: { cursor },
            }),
            signal: controller.signal,
          }),
        );
        if (page.teamId !== teamId)
          throw new Error(
            "The hosted project workspace changed. Refresh connections.",
          );
        projects.push(...page.projects.filter((item) => !item.archived));
        cursor = page.nextCursor ?? undefined;
        if (cursor && cursors.has(cursor))
          throw new Error("Project pagination stalled. Refresh connections.");
        if (cursor) cursors.add(cursor);
      } while (cursor && !controller.signal.aborted);
      if (controller.signal.aborted) return;
      let entries = retained.get(connection!);
      if (!entries) {
        entries = new Map();
        retained.set(connection!, entries);
      }
      const previous = entries.get(key)?.selected;
      const selected =
        previous && projects.some((item) => item.id === previous)
          ? previous
          : projects.length === 1
            ? projects[0]!.id
            : "";
      const next = { projects, selected };
      entries.set(key, next);
      setState({ key, connection: connection!, value: next });
    }
    void read()
      .catch((failure) => {
        if (!controller.signal.aborted)
          setError(
            failure instanceof Error
              ? failure.message
              : "Unable to list hosted projects.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [connection, key, teamId, account?.state, revision]);
  const select = useCallback(
    (selected: string) => {
      if (!connection) return;
      const entry = retained.get(connection)?.get(key);
      if (!entry || !entry.projects.some((item) => item.id === selected))
        return;
      const next = { ...entry, selected };
      retained.get(connection)!.set(key, next);
      setState({ key, connection, value: next });
    },
    [connection, key],
  );
  return {
    projects: value?.projects ?? [],
    projectId: value?.selected ?? "",
    select,
    error,
    loading,
    refresh: () => setRevision((current) => current + 1),
  };
}
