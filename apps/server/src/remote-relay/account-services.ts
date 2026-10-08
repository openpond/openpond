import type { AppPreferences } from "@openpond/contracts";
import { remoteRelayAccount, remoteRelayAccountStatus } from "./account.js";
import { createRemoteCommandExecutor } from "./executor.js";
import { createRemoteRelayManager } from "./manager.js";
import type { RemoteRelayDependencies } from "./manager-types.js";
import { createRemoteOutputReader, createRemoteQualifiedOutputReader } from "./output-refs.js";
import { createRemoteStarterResolver } from "./starters.js";

type CommandServices = Omit<Parameters<typeof createRemoteCommandExecutor>[0],
  "store" | "inspect" | "resolveStarter">;

/** Compose account-scoped relay services from the owning runtime's canonical operations. */
export function createAccountRemoteRelayManager(input: Pick<RemoteRelayDependencies,
  "storeDir" | "installation" | "store" | "inspect" | "prepareOwnerAttachment" | "caller" | "listen" | "warn"> & {
  loadAppPreferences(): Promise<AppPreferences>;
  commands: CommandServices;
  readQualifiedOutput: Parameters<typeof createRemoteQualifiedOutputReader>[1];
}) {
  const { loadAppPreferences, commands, readQualifiedOutput, ...deps } = input;
  const current = remoteRelayAccount(deps.installation.installationId, loadAppPreferences);
  return createRemoteRelayManager({
    ...deps,
    current,
    accountStatus: () => remoteRelayAccountStatus(loadAppPreferences),
    execute: createRemoteCommandExecutor({
      ...commands,
      store: deps.store,
      inspect: deps.inspect,
      resolveStarter: createRemoteStarterResolver({ store: deps.store, current }),
    }),
    outputs: createRemoteOutputReader(deps.store),
    readOutput: createRemoteQualifiedOutputReader(deps.store, readQualifiedOutput),
  });
}
