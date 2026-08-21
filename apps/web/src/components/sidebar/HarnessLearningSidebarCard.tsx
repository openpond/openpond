import { useCallback, useEffect, useState } from "react";
import type { HarnessHistoryPayload } from "@openpond/contracts";

import { api, type ClientConnection } from "../../api";
import {
  readHarnessLearningNoticeDismissed,
  rememberHarnessLearningNoticeDismissed,
} from "../../lib/harness-learning-notice-preference";
import { Settings, X } from "../icons";

export function HarnessLearningSidebarCard({
  connection,
  onOpenSettings,
}: {
  connection: ClientConnection | null;
  onOpenSettings: () => void;
}) {
  const [history, setHistory] = useState<HarnessHistoryPayload | null>(null);
  const [dismissed, setDismissed] = useState(
    readHarnessLearningNoticeDismissed
  );

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
  const continuousReviewStatus = schedule.activityEnabled
    ? `${schedule.activityBatchSize} outcomes${schedule.enabled ? ` + ${schedule.cadence}` : ""}`
    : schedule.enabled
      ? schedule.cadence
      : "Manual";

  return (
    <section className="sidebar-learning-notice" aria-label="Continuous learning">
      <header>
        <strong>Continuous learning</strong>
        <div className="sidebar-learning-notice-actions">
          <button
            className="sidebar-learning-notice-action"
            aria-label="Open Continuous learning settings"
            onClick={onOpenSettings}
            type="button"
          >
            <Settings size={14} />
          </button>
          <button
            className="sidebar-learning-notice-action"
            aria-label="Close continuous learning"
            onClick={() => {
              setDismissed(true);
              rememberHarnessLearningNoticeDismissed();
            }}
            type="button"
          >
            <X size={14} />
          </button>
        </div>
      </header>
      <div className="sidebar-learning-status">
        <strong>Refiner</strong>
        <span>{history.backgroundReview.enabled ? "On" : "Off"}</span>
      </div>
      <div className="sidebar-learning-status">
        <strong>Continuous Review</strong>
        <span>{continuousReviewStatus}</span>
      </div>
    </section>
  );
}
