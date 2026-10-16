import type {HostedPonderBinding} from "../store/store-ponder-hosted.js";
import type {createCapturedOpenPondPublicApiClient} from "./account-public-api-client.js";
export type HostedPonderAccess={account:HostedPonderBinding;client:ReturnType<typeof createCapturedOpenPondPublicApiClient>};
