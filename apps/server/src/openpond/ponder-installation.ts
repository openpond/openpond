// One durable installation key is shared by the account relay and the Ponder caller.
export { loadDeviceInstallation as loadPonderInstallation } from "../remote-relay/installation.js";
export type { DeviceInstallation as PonderInstallation } from "../remote-relay/installation.js";
