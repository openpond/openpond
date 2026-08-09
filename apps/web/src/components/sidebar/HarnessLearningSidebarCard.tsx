import { useCallback, useEffect, useState } from "react";
import type { HarnessHistoryPayload } from "@openpond/contracts";

import { api, type ClientConnection } from "../../api";
import { X } from "../icons";

export function HarnessLearningSidebarCard({
  connection,
}: {
  connection: ClientConnection | null;
}) {
  const [history, setHistory] = useState<HarnessHistoryPayload | null>(null);
  const [busy, setBusy] = useState<"refiner" | "review" | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const refresh = useCallback(async () => {
    if (!connection) {
      setHistory(null);
      return;
    }
    try {
      setHistory(await api.harnessHistory(connection));
    } catch {
      setHistory(null);
    }
  }, [connection]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (dismissed || !connection || !history?.workspace) return null;
  const schedule = history.evaluationReviewSchedule;

  return (
    <section className="sidebar-learning-notice" aria-label="Continuous learning">
      <header>
        <strong>Continuous learning</strong>
        <button
          className="sidebar-learning-notice-dismiss"
          aria-label="Close continuous learning"
          onClick={() => setDismissed(true)}
          type="button"
        >
          <X size={14} />
        </button>
      </header>
      <label className="sidebar-learning-control">
        <span><strong>Refiner</strong><small>After each turn</small></span>
        <span className="provider-toggle sidebar-learning-toggle">
          <input
            checked={history.backgroundReview.enabled}
            disabled={busy !== null}
            onChange={(event) => {
              const enabled = event.target.checked;
              setBusy("refiner");
              void api.updateHarnessBackgroundReview(connection, {
                workspaceId: history.workspace!.id,
                enabled,
              }).then((response) => setHistory(response.history))
                .finally(() => setBusy(null));
            }}
            type="checkbox"
          />
          <span aria-hidden="true" />
        </span>
      </label>
      <label className="sidebar-learning-control">
        <span><strong>Pattern review</strong><small>{schedule.cadence}</small></span>
        <span className="provider-toggle sidebar-learning-toggle">
          <input
            checked={schedule.enabled}
            disabled={busy !== null}
            onChange={(event) => {
              const enabled = event.target.checked;
              const cadence = enabled && schedule.cadence === "manual"
                ? "daily"
                : schedule.cadence;
              setBusy("review");
              void api.updateHarnessEvaluationReviewSchedule(connection, {
                workspaceId: history.workspace!.id,
                enabled,
                cadence,
                maxEstimatedCostUsd: schedule.maxEstimatedCostUsd,
              }).then((response) => setHistory(response.history))
                .finally(() => setBusy(null));
            }}
            type="checkbox"
          />
          <span aria-hidden="true" />
        </span>
      </label>
    </section>
  );
}
