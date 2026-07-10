import type {
  BootstrapPayload,
  CloudWorkspaceReadyStatus,
  LocalProject,
  Session,
} from "@openpond/contracts";
import { api, type ClientConnection } from "../api";
import type { SandboxRecord } from "./sandbox-types";
import { isCloudWorkspaceKind } from "./workspace-location";

export type { CloudWorkspaceReadyStatus } from "@openpond/contracts";

export type CloudWorkspaceReadyResult = {
  bootstrap?: BootstrapPayload;
  output?: string;
  sandbox: SandboxRecord | null;
  session: Session;
  status: CloudWorkspaceReadyStatus;
};

type EnsureCloudWorkspaceRunningInput = {
  branch?: string | null;
  connection: ClientConnection;
  localProject?: LocalProject | null;
  session: Session;
  source: string;
};

export async function ensureCloudWorkspaceRunning({
  branch,
  connection,
  session,
}: EnsureCloudWorkspaceRunningInput): Promise<CloudWorkspaceReadyResult> {
  if (!isCloudWorkspaceKind(session.workspaceKind)) {
    return { sandbox: null, session, status: "already_running" };
  }
  const result = await api.ensureCloudWorkspaceReady(connection, session.id, {
    branch,
    surface: "desktop",
  });
  return {
    bootstrap: await api.bootstrap(connection),
    output: result.output,
    sandbox: null,
    session: result.session,
    status: result.status,
  };
}
