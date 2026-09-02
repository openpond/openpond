import type { ModelRun, TrainingJob } from "@openpond/contracts";

import { statusLabel } from "../training/training-model-data";
import { LabStatusBadge } from "./LabStatusBadge";

const ACTIVE_RUN_STATUSES = new Set([
  "queued",
  "starting",
  "running",
  "reconciling",
]);

export function isActiveRunStatus(status: string): boolean {
  return ACTIVE_RUN_STATUSES.has(status);
}

export function resolveRunStatus({
  job,
  lifecycleRun,
}: {
  job: Pick<TrainingJob, "status"> | null;
  lifecycleRun: Pick<ModelRun, "status"> | null;
}): string {
  return lifecycleRun?.status ?? job?.status ?? "not_run";
}

export function LabRunStatusBadge({ status }: { status: string }) {
  const active = isActiveRunStatus(status);
  return (
    <LabStatusBadge
      label={statusLabel(status)}
      pulse={active}
      tone={active ? "positive" : undefined}
      value={status}
    />
  );
}
