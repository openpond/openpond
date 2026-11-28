import type { ClientConnection } from "../../api/api-client";
import type { useTraining } from "../../hooks/useTraining";
import { HostedServingModels } from "./HostedServingModels";
import { ModelProjectPageHeader } from "./ModelProjectPageHeader";
import { DesktopNewMenu } from "../chat/DesktopNewMenu";

export function LabServingPage({
  modelProjectId = null, connection, teamId, actorId, accountKey, training,
}: {
  connection: ClientConnection | null;
  teamId: string | null;
  actorId: string | null;
  accountKey: string;
  training?: ReturnType<typeof useTraining>;
  modelProjectId?: string | null;
}) {
  return <div className="labs-flat-body labs-serving-page">
    <ModelProjectPageHeader title="Serving" description="Serve your models." actions={<DesktopNewMenu />} />
    {connection && teamId && actorId && training ? (
      <HostedServingModels key={`${accountKey}:${actorId}:${teamId}`} connection={connection}
        teamId={teamId} actorId={actorId} accountKey={accountKey} modelProjectId={modelProjectId} training={training} />
    ) : <div className="labs-table-empty">Sign in and select a workspace to view your models.</div>}
  </div>;
}
