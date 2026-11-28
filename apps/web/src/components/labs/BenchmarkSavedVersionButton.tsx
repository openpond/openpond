import { useContext } from "react";
import type { TrainingModelVersion } from "openpond-sdk/training";
import { DesktopNewContext } from "../chat/DesktopNewMenu";

export function BenchmarkSavedVersionButton({ version, name }: { version: TrainingModelVersion; name: string }) {
  const action = useContext(DesktopNewContext);
  if (!action) return null;
  return <button type="button" className="training-button secondary"
    onClick={() => action.create("benchmark", {
      location: "cloud",
      label: name,
      teamId: version.teamId,
      modelProjectId: version.modelProjectId,
      jobId: version.jobId,
      versionHash: version.contentHash,
    })}>
    Benchmark this version
  </button>;
}
