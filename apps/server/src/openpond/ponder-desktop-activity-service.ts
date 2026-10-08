import { createDesktopPonderActivityBridge } from "../runtime/task-inbox/desktop-agent-services.js";
import type { SqliteStore } from "../store/store.js";
import type { PonderInstallation } from "./ponder-installation.js";
import { PonderLocalOwnerSchema } from "./ponder-local-scope.js";

type BridgeInput = Parameters<typeof createDesktopPonderActivityBridge>[0];

export function createServerPonderActivity(deps: {
  storeDir: string;
  installation: PonderInstallation;
  store: Pick<SqliteStore, "getSession" | "listChatWorkflows" | "listChatWorkflowRuns">;
  subscribe: BridgeInput["subscribe"];
  loadAppPreferences: BridgeInput["loadAppPreferences"];
  warn: BridgeInput["warn"];
}) {
  return createDesktopPonderActivityBridge({
    storeDir: deps.storeDir,
    deviceId: deps.installation.installationId,
    subscribe: deps.subscribe,
    loadAppPreferences: deps.loadAppPreferences,
    sessionTitle: async id => (await deps.store.getSession(id))?.title ?? "Local chat",
    sessionOwner: async id => {
      const owner = PonderLocalOwnerSchema.safeParse((await deps.store.getSession(id))?.metadata?.ponderLocalOwner);
      return owner.success ? owner.data : null;
    },
    workflows: async () => ({ workflows: await deps.store.listChatWorkflows(), runs: await deps.store.listChatWorkflowRuns(null, 500) }),
    warn: deps.warn,
  });
}
