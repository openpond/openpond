import { useEffect, useState } from "react";
import type { ModelProject } from "@openpond/contracts";
import type { useTraining } from "../../hooks/useTraining";

export function useHostedModelRefresh(model: ModelProject | null, teamId: string | null, apiOrigin: string | null, training: ReturnType<typeof useTraining>) {
  const hostedId = model?.hosted?.projectId;
  const linkedTeam = model?.hosted?.teamId;
  const linkedOrigin = model?.hosted?.apiOrigin;
  const refresh = training.actions.openHostedModelProject;
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const key = JSON.stringify([hostedId, linkedTeam, linkedOrigin, teamId, apiOrigin]);
  useEffect(() => {
    if (!hostedId || !teamId || !apiOrigin || linkedTeam !== teamId || linkedOrigin !== new URL(apiOrigin).origin) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function read() {
      const result = await refresh(hostedId!, teamId!, apiOrigin!, { silent: true });
      if (stopped) return;
      setFailure(result ? null : { key, message: "Hosted runs could not be refreshed. Showing the last saved state." });
      timer = setTimeout(() => { void read(); }, 10_000);
    }
    void read();
    return () => { stopped = true; clearTimeout(timer); };
  }, [hostedId, teamId, apiOrigin, linkedTeam, linkedOrigin, refresh, key]);
  return failure?.key === key ? failure.message : null;
}
