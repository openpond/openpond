import type { ClientConnection } from "../../api/api-client";
import { InboxControl } from "../human-review/InboxControl";
import { modelsLocation, navigateModelsRoute } from "../labs/lab-primary-tab-state";

export function WorkspaceHeaderControls({
  connection,
  teamId,
  actorId,
  projectId,
}: {
  connection: ClientConnection | null;
  teamId: string | null;
  actorId: string | null;
  projectId: string | null;
}) {
  if (!connection || !teamId || !actorId) return null;
  const openInbox = () => {
    void navigateModelsRoute(modelsLocation("inbox", null, { area: "console", projectId }));
  };
  return <InboxControl context={{ connection, scope: teamId, actorId, location: "hosted" }} onOpen={openInbox} />;
}
