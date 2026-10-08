import { isRecoverableStartupError, startRecoveryServer } from "./api/startup-recovery.js";
import { resolveOpenPondHome } from "@openpond/persistence";
import { getBundledRuntimeVersion, openUrlWithSystemBrowser } from "@openpond/runtime";
import { runAppServerJsonl, type AppServerInstance } from "@openpond/app-server";
import { AgentHostStorageClient } from "@openpond/agent-runtime";
import { createHostedRuntimeCoreStorage } from "./store/hosted-turn-repository.js";
import { HostedTaskInboxStorage } from "./store/hosted-task-inbox-storage.js";
import {readHostProfileExternalDataset} from "./harness/host-profile-external-dataset.js";
import { createHostedModelStreamFromEnvironment } from "./runtime/hosted-model-stream.js";
import { AdmittedHostedProfileReleaseSchema, type AdmittedHostedProfileRelease } from "./store/hosted-profile-source.js";
import type { OpenPondAppServerOptions } from "./app-server-runtime.js";
import { existsSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { validateHarnessSourcePackage } from "@openpond/harness";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_HOST, DEFAULT_PORT } from "./constants.js";
import type { OpenPondServerInstance, OpenPondServerOptions } from "./types.js";
import { parseListen } from "./utils.js";

type CreateServer = (options: OpenPondServerOptions) => Promise<OpenPondServerInstance>;
type ProfileSourceCliOptions = { repoPath: string; repositoryId: string; profileId: string; sourceRevision: string };
type CreateAgentServer = (options: OpenPondAppServerOptions) => Promise<AppServerInstance>;
type ServerCliFactories = {
  createOpenPondServer: CreateServer;
  createOpenPondAppServer: CreateAgentServer;
};
type CliMode = "app-server" | "serve" | "web";
type ParsedCliArgs = {
  mode: CliMode;
  host: string;
  port: number;
  webRoot: string | null;
  openBrowser: boolean;
  printAccessUrl: boolean;
  storeDir: string | null;
  hostedCacheHome?: string;
  experimentOwner?: boolean;
  experimentHarnessPackage?: string;
  profileExternalDatasetPackage?:string;
  sourceBrowserState?: string;
  profileSource?: ProfileSourceCliOptions;
  admittedProfileRelease?: AdmittedHostedProfileRelease;
  runtimeStorage: "sqlite_bundle" | "hosted_postgres";
  help: boolean;
};
type BrowserHandoff = typeof openUrlWithSystemBrowser;

export type WebLaunchMessages = {
  stdout: string[];
  stderr: string[];
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function parsePort(value: string, flag: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isFinite(port) || port < 0 || port > 65535) throw new Error(`${flag} must be a port from 0 to 65535.`);
  return port;
}

function parseCliArgs(args: string[]): ParsedCliArgs {
  let mode: CliMode = "serve";
  let host = DEFAULT_HOST;
  let port = DEFAULT_PORT;
  let webRoot: string | null = null;
  let openBrowser = false;
  let printAccessUrl = false;
  let storeDir: string | null = null;
  let hostedCacheHome: string | undefined;
  let experimentOwner=false;
  let experimentHarnessPackage: string | undefined;
  let profileExternalDatasetPackage:string|undefined;
  let sourceBrowserState: string | undefined;
  let profileSourceRoot: string | null = null;
  let profileRepositoryId: string | null = null;
  let profileId: string | null = null;
  let profileRevision: string | null = null;
  let admittedProfileRelease: AdmittedHostedProfileRelease | undefined;
  let runtimeStorage: ParsedCliArgs["runtimeStorage"] = "sqlite_bundle";
  let index = 0;

  const command = args[0];
  if (command && !command.startsWith("-")) {
    if (command === "serve" || command === "server") mode = "serve";
    else if (command === "app-server") mode = "app-server";
    else if (command === "web") mode = "web";
    else if (command === "help") {
      return { mode, host, port, webRoot, openBrowser, printAccessUrl, storeDir, runtimeStorage, help: true };
    }
    else throw new Error(`Unknown command: ${command}`);
    index = 1;
  }

  for (let i = index; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") {
      return { mode, host, port, webRoot, openBrowser, printAccessUrl, storeDir, runtimeStorage, help: true };
    }
    if (arg === "--listen") {
      const listen = parseListen(requireValue(args, i, arg));
      host = listen.host;
      port = parsePort(String(listen.port), arg);
      i += 1;
    } else if (arg === "--hostname" || arg === "--host") {
      host = requireValue(args, i, arg);
      i += 1;
    } else if (arg === "--port") {
      port = parsePort(requireValue(args, i, arg), arg);
      i += 1;
    } else if (arg === "--web-root") {
      webRoot = path.resolve(requireValue(args, i, arg));
      i += 1;
    } else if (arg === "--source-browser-state") {
      sourceBrowserState = path.resolve(requireValue(args, i, arg)); i += 1;
    } else if (arg === "--store-dir") {
      throw new Error("--store-dir has been replaced by --home. Use --home <directory> or OPENPOND_HOME.");
    } else if (arg === "--home") {
      storeDir = path.resolve(requireValue(args, i, arg));
      i += 1;
    } else if (arg === "--hosted-cache-home") {
      hostedCacheHome = path.resolve(requireValue(args, i, arg)); i += 1;
    } else if (arg === "--experiment-owner") {
      experimentOwner=true;
    } else if (arg === "--experiment-harness-package") {
      if (experimentHarnessPackage) throw new Error("Duplicate Experiment Harness source package.");
      experimentHarnessPackage = path.resolve(requireValue(args, i, arg)); i += 1;
    } else if (arg === "--runtime-storage") {
      const value = requireValue(args, i, arg);
      if (value !== "hosted-postgres") throw new Error("Unsupported app-server runtime storage.");
      runtimeStorage = "hosted_postgres";
      i += 1;
    } else if(arg === "--profile-external-dataset-package"){
      if(profileExternalDatasetPackage)throw new Error("Duplicate private external Dataset package.");profileExternalDatasetPackage=path.resolve(requireValue(args,i,arg));i+=1;
    } else if (arg === "--profile-source-root") {
      profileSourceRoot = path.resolve(requireValue(args, i, arg)); i += 1;
    } else if (arg === "--profile-repository-id") {
      profileRepositoryId = requireValue(args, i, arg); i += 1;
    } else if (arg === "--profile-id") {
      profileId = requireValue(args, i, arg); i += 1;
    } else if (arg === "--profile-revision") {
      profileRevision = requireValue(args, i, arg); i += 1;
    } else if (arg === "--hosted-profile-release") {
      if (admittedProfileRelease) throw new Error("Duplicate hosted Profile release descriptor.");
      const encoded = requireValue(args, i, arg);
      if (encoded.length > 16_000 || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
        throw new Error("Invalid hosted Profile release descriptor.");
      }
      try {
        admittedProfileRelease = AdmittedHostedProfileReleaseSchema.parse(
          JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
      } catch {
        throw new Error("Invalid hosted Profile release descriptor.");
      }
      i += 1;
    } else if (arg === "--open-browser") {
      openBrowser = true;
    } else if (arg === "--print-access-url") {
      printAccessUrl = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (openBrowser && printAccessUrl) {
    throw new Error("--open-browser and --print-access-url cannot be used together.");
  }
  if (mode !== "web" && (openBrowser || printAccessUrl)) {
    throw new Error("Browser options are only available in web mode.");
  }
  const profileFlags = [profileSourceRoot, profileRepositoryId, profileId, profileRevision].filter(Boolean).length;
  if (profileFlags && (profileFlags !== 4 || mode !== "app-server")) {
    throw new Error("Profile source flags require app-server mode and --profile-source-root, --profile-repository-id, --profile-id, and --profile-revision together.");
  }
  if (runtimeStorage === "hosted_postgres" && (mode !== "app-server" || storeDir || profileFlags)) {
    throw new Error("Hosted Postgres app-server cannot use --home or local Profile source flags.");
  }
  if (admittedProfileRelease && runtimeStorage !== "hosted_postgres") {
    throw new Error("Hosted Profile release requires hosted Postgres app-server mode.");
  }
  if (hostedCacheHome && runtimeStorage !== "hosted_postgres") throw new Error("Hosted cache home requires hosted Postgres mode.");
  if(experimentOwner && (mode!=="app-server" || runtimeStorage!=="sqlite_bundle" || profileFlags || !storeDir)) throw new Error("Experiment owner mode requires an isolated app-server home without Profile selection.");
  if (experimentHarnessPackage && (!experimentOwner || path.dirname(experimentHarnessPackage) !== storeDir))
    throw new Error("Experiment Harness source must be provisioned directly inside its isolated owner home.");
  return {
    mode, host, port, webRoot, openBrowser, printAccessUrl, storeDir, runtimeStorage, sourceBrowserState,
    ...(profileExternalDatasetPackage?{profileExternalDatasetPackage}:{}),
    ...(profileFlags ? { profileSource: { repoPath: profileSourceRoot!, repositoryId: profileRepositoryId!, profileId: profileId!, sourceRevision: profileRevision! } } : {}),
    ...(admittedProfileRelease ? { admittedProfileRelease } : {}),
    ...(hostedCacheHome ? { hostedCacheHome } : {}),
    ...(experimentOwner ? {experimentOwner:true} : {}),
    ...(experimentHarnessPackage ? { experimentHarnessPackage } : {}),
    help: false,
  };
}

function defaultWebRootCandidates(): string[] {
  return [
    process.env.OPENPOND_WEB_ROOT,
    path.resolve(process.cwd(), "apps/web/dist"),
    path.resolve(__dirname, "../../web/dist"),
    path.resolve(process.cwd(), "web"),
    path.resolve(__dirname, "../web"),
  ].filter((candidate): candidate is string => Boolean(candidate));
}

function resolveWebRoot(explicitWebRoot: string | null): string | null {
  const candidates = explicitWebRoot ? [explicitWebRoot] : defaultWebRootCandidates();
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (existsSync(path.join(resolved, "index.html"))) return resolved;
  }
  return null;
}

function formatHostForUrl(host: string): string {
  const browserHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return browserHost.includes(":") && !browserHost.startsWith("[") ? `[${browserHost}]` : browserHost;
}

function browserBaseUrl(instance: OpenPondServerInstance): string {
  return `http://${formatHostForUrl(instance.status.host)}:${instance.status.port}`;
}

function tokenizedWebUrl(baseUrl: string, token: string): string {
  const url = new URL(baseUrl);
  const params = new URLSearchParams();
  params.set("openpondServerUrl", baseUrl);
  params.set("openpondToken", token);
  url.hash = params.toString();
  return url.toString();
}

export async function resolveWebLaunchMessages(
  input: {
    baseUrl: string;
    openBrowser: boolean;
    printAccessUrl: boolean;
    token: string;
  },
  handOffToBrowser: BrowserHandoff = openUrlWithSystemBrowser,
): Promise<WebLaunchMessages> {
  const accessUrl = tokenizedWebUrl(input.baseUrl, input.token);
  if (input.printAccessUrl) {
    return { stdout: [`OpenPond access URL: ${accessUrl}`], stderr: [] };
  }
  if (!input.openBrowser) {
    return { stdout: [`OpenPond web UI: ${input.baseUrl}`], stderr: [] };
  }

  const handoff = await handOffToBrowser(accessUrl);
  if (handoff.opened) {
    return { stdout: [`Opened OpenPond in your browser: ${input.baseUrl}`], stderr: [] };
  }
  return {
    stdout: [`OpenPond access URL: ${accessUrl}`],
    stderr: [`Could not open the system browser: ${handoff.error}`],
  };
}

function printHelp(): void {
  console.log(`Usage:
  openpond-app-server serve [--hostname HOST] [--port PORT]
  openpond-app-server app-server [--home DIR]
  openpond-app-server web [--hostname HOST] [--port PORT] [--web-root DIR]

Options:
  --listen HOST:PORT     Set host and port together
  --hostname HOST        Bind host (default ${DEFAULT_HOST})
  --port PORT            Bind port, or 0 for any free port (default ${DEFAULT_PORT})
  --web-root DIR         Directory containing the built web UI for web mode
  --home DIR        Local app-server state directory
  --runtime-storage hosted-postgres  Host-admitted Postgres app-server mode
  --hosted-profile-release BASE64URL  Host-admitted immutable Profile release descriptor
  --profile-source-root DIR  Authorized Profile repository source for app-server
  --profile-repository-id ID Source repository identity supplied by the host
  --profile-id ID            Profile within that source
  --profile-revision REV     Accepted immutable source revision
  --open-browser         Open the authenticated web URL in the system browser
  --print-access-url     Print the authenticated URL instead of opening it
`);
}

export async function runOpenPondServerCli(factories: ServerCliFactories): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const webRoot = args.mode === "web" ? resolveWebRoot(args.webRoot) : null;
  if (args.mode === "web" && !webRoot) {
    throw new Error("Could not find a built OpenPond web UI. Run `pnpm build:web` or pass --web-root.");
  }

  if (args.mode === "app-server") {
    await runAgentServer(factories.createOpenPondAppServer, args.storeDir, args.profileSource, args.runtimeStorage,
      args.admittedProfileRelease, args.hostedCacheHome,args.experimentOwner,args.experimentHarnessPackage,args.profileExternalDatasetPackage);
    return;
  }

  if (args.storeDir) process.env.OPENPOND_HOME = args.storeDir;
  let instance: OpenPondServerInstance;
  let port = args.port;
  while (true) {
    try {
      instance = await factories.createOpenPondServer({ host: args.host, port, webRoot, sourceBrowserState: args.sourceBrowserState,
        ...(args.storeDir ? { storeDir: args.storeDir } : {}), httpEnabled: true });
      break;
    } catch (error) {
      if (!isRecoverableStartupError(error)) throw error;
      const recovery = await startRecoveryServer(resolveOpenPondHome({ home: args.storeDir ?? undefined }), port, error);
      port = recovery.port;
      console.log(`OPENPOND_APP_SERVER_READY ${JSON.stringify({ mode: "recovery", url: recovery.url, tokenFile: recovery.tokenFile, storePath: recovery.storePath })}`);
      console.error(`${error.issue.code}: ${error.issue.message} ${error.issue.action}`);
      const messages = await resolveWebLaunchMessages({ baseUrl: recovery.url, openBrowser: args.openBrowser, printAccessUrl: args.printAccessUrl, token: recovery.token });
      for (const message of messages.stdout) console.log(message);
      for (const message of messages.stderr) console.error(message);
      const close = () => { void recovery.close().finally(() => process.exit(0)); };
      process.once("SIGINT", close); process.once("SIGTERM", close);
      try { await recovery.repaired; } finally { process.off("SIGINT", close); process.off("SIGTERM", close); await recovery.close(); }
    }
  }
  const webBaseUrl = args.mode === "web" ? browserBaseUrl(instance) : null;
  console.log(
    `OPENPOND_APP_SERVER_READY ${JSON.stringify({
      mode: args.mode,
      url: instance.url,
      webUrl: null,
      webRoot,
      tokenFile: instance.tokenFile,
      storePath: instance.storePath,
      runtime: getBundledRuntimeVersion(),
    })}`
  );
  if (webBaseUrl) {
    const messages = await resolveWebLaunchMessages({
      baseUrl: webBaseUrl,
      openBrowser: args.openBrowser,
      printAccessUrl: args.printAccessUrl,
      token: instance.token,
    });
    for (const message of messages.stderr) console.error(message);
    for (const message of messages.stdout) console.log(message);
  } else {
    console.log(`OpenPond API server: ${instance.url}`);
  }
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await instance.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  await new Promise<void>(() => {
    // Keep the CLI entrypoint alive when the server is launched outside Electron.
  });
}

export async function runOpenPondAppServerCli(
  createOpenPondAppServer: CreateAgentServer,
): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const args = parseCliArgs(
    !rawArgs[0] || rawArgs[0].startsWith("-")
      ? ["app-server", ...rawArgs]
      : rawArgs,
  );
  if (args.help) {
    printHelp();
    return;
  }
  if (args.mode !== "app-server") {
    throw new Error("The app-server entrypoint only accepts the app-server command.");
  }
  await runAgentServer(createOpenPondAppServer, args.storeDir, args.profileSource,
    args.runtimeStorage, args.admittedProfileRelease, args.hostedCacheHome,args.experimentOwner,args.experimentHarnessPackage,args.profileExternalDatasetPackage);
}

async function runAgentServer(
  createOpenPondAppServer: CreateAgentServer,
  storeDir: string | null,
  profileSource?: ProfileSourceCliOptions,
  runtimeStorage: ParsedCliArgs["runtimeStorage"] = "sqlite_bundle",
  admittedProfileRelease?: AdmittedHostedProfileRelease,
  hostedCacheHome?: string,
  experimentOwner=false,
  experimentHarnessPackage?: string,
  profileExternalDatasetPackage?:string,
): Promise<void> {
  const hostStorageClient = new AgentHostStorageClient();
  if (runtimeStorage === "hosted_postgres") {
    if (storeDir || profileSource) throw new Error("Hosted Postgres app-server cannot use local storage sources.");
    const externalDataset = profileExternalDatasetPackage
      ? await (hostedCacheHome && admittedProfileRelease?.hostExecution && !experimentOwner
          ? readHostProfileExternalDataset(profileExternalDatasetPackage, hostedCacheHome)
          : Promise.reject(new Error("External Dataset requires its private hosted evaluation owner.")))
      : undefined;
    await runAppServerJsonl({
      appServer: () => createOpenPondAppServer({
        ...(hostedCacheHome ? { storeDir: hostedCacheHome } : {}),
        hostStorageClient,
        ...(externalDataset ? { profileExternalDataset: externalDataset } : {}),
        runtimeStorage: {
          kind: "hosted_postgres", client: hostStorageClient,
          core: createHostedRuntimeCoreStorage(hostStorageClient),
          inbox: new HostedTaskInboxStorage(hostStorageClient),
          ...(admittedProfileRelease ? { admittedProfileRelease } : {}),
        },
        streamOpenPondHostedChatTurn: createHostedModelStreamFromEnvironment(),
      }),
      readable: process.stdin, writable: process.stdout, hostStorageClient,
    });
    return;
  }
  if (storeDir) process.env.OPENPOND_HOME = storeDir;
  let experimentHarnessSource: OpenPondAppServerOptions["experimentHarnessSource"];
  if (experimentHarnessPackage) {
    if (!experimentOwner || !storeDir || path.dirname(experimentHarnessPackage) !== storeDir
      || await realpath(experimentHarnessPackage) !== experimentHarnessPackage)
      throw new Error("Experiment Harness source escaped its isolated owner home.");
    const descriptor = await lstat(experimentHarnessPackage);
    if (!descriptor.isFile() || descriptor.size > 67_108_864)
      throw new Error("Experiment Harness source package is not a bounded regular file.");
    experimentHarnessSource = { ownerId: "host-experiment-case", sourcePackage: validateHarnessSourcePackage(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readFile(experimentHarnessPackage)))) };
  }
  const externalDataset=profileExternalDatasetPackage?await (storeDir&&profileSource&&!experimentOwner?readHostProfileExternalDataset(profileExternalDatasetPackage,storeDir):Promise.reject(new Error("External Dataset bootstrap requires a private explicit Profile owner."))):undefined;
  const externalStream=externalDataset?createHostedModelStreamFromEnvironment():undefined;
  const appServer = await createOpenPondAppServer({
    ...(storeDir ? { storeDir } : {}),
    ...(profileSource ? { profileSource } : {}),
    ...(externalDataset?{profileExternalDataset:externalDataset,profileExternalDatasetClient:hostStorageClient,streamOpenPondHostedChatTurn:async function*(input){const fence=async()=>{await hostStorageClient.request({contractVersion:1,requestId:crypto.randomUUID(),operation:"profile.externalDataset.authorize",params:{bindingHash:externalDataset.binding.contentHash}});};await fence();const controller=new AbortController();let checking=false;const timer=setInterval(()=>{if(checking||controller.signal.aborted)return;checking=true;void fence().catch(error=>controller.abort(error)).finally(()=>{checking=false;});},2000);try{const signal=AbortSignal.any([...(input.signal?[input.signal]:[]),controller.signal]);signal.throwIfAborted();for await(const chunk of externalStream!({...input,signal})){await fence();signal.throwIfAborted();yield chunk;}}finally{clearInterval(timer);controller.abort();}},services:{webSearch:false,scheduling:false,connectedApps:false,tasksets:false,projectActions:false,profileActions:false,backgroundReview:false}}:{}),
    ...(experimentHarnessSource ? { experimentHarnessSource } : {}),
    ...(experimentOwner?{experimentPolicyClient:hostStorageClient,
      services:{webSearch:false,scheduling:false,connectedApps:false,tasksets:false,projectActions:false,profileActions:false,backgroundReview:false},
    }:{}),
    hostStorageClient,
  });
  await runAppServerJsonl({
    appServer,
    readable: process.stdin,
    writable: process.stdout,
    hostStorageClient,
  });
}
