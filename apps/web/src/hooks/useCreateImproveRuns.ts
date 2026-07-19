import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CreateImproveRun } from "@openpond/contracts";

import { api, type ClientConnection } from "../api";

const ACTIVE_RUN_STATES = new Set<CreateImproveRun["state"]>([
  "planning",
  "awaiting_questions",
  "awaiting_plan_approval",
  "paused",
  "applying_source",
  "running_checks",
  "evaluating",
  "awaiting_promotion",
  "opening_pull_request",
  "pull_request_open",
  "reconciling_release",
  "pushing_hosted",
  "running_hosted_checks",
]);

export function useCreateImproveRuns(input: {
  connection: ClientConnection | null;
  profileId: string;
}) {
  const { connection, profileId } = input;
  const [runs, setRuns] = useState<CreateImproveRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef<Promise<CreateImproveRun[] | null> | null>(null);

  const refresh = useCallback(() => {
    if (!connection) return Promise.resolve(null);
    if (inFlightRef.current) return inFlightRef.current;
    setLoading(true);
    const request = api.listCreateImproveRuns(connection, { profileId, limit: 500 })
      .then((response) => {
        setRuns(response.runs);
        setError(null);
        return response.runs;
      })
      .catch((caught) => {
        setError(caught instanceof Error ? caught.message : String(caught));
        return null;
      })
      .finally(() => {
        if (inFlightRef.current === request) inFlightRef.current = null;
        setLoading(false);
      });
    inFlightRef.current = request;
    return request;
  }, [connection, profileId]);

  useEffect(() => {
    if (!connection) {
      setRuns([]);
      setError(null);
      return;
    }
    void refresh();
  }, [connection, profileId, refresh]);

  const hasActiveRun = useMemo(
    () => runs.some((run) => ACTIVE_RUN_STATES.has(run.state)),
    [runs],
  );

  useEffect(() => {
    if (!connection) return undefined;
    let active = true;
    let timer: number | null = null;
    const poll = async () => {
      await refresh();
      if (active) {
        timer = window.setTimeout(() => void poll(), hasActiveRun ? 1_000 : 15_000);
      }
    };
    timer = window.setTimeout(() => void poll(), hasActiveRun ? 1_000 : 15_000);
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [connection, hasActiveRun, refresh]);

  return { runs, loading, error, refresh };
}
