import { randomUUID } from "node:crypto";
import { access, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  ANTIGRAVITY_PROVIDER_ID,
  type AntigravitySetupState,
  type AntigravityRuntimeState,
  type ProviderSettings,
} from "@openpond/contracts";
import {
  readProvidersFile,
  updateProvidersFile,
  mergeProviderConfigPatch,
} from "../../openpond/provider-settings.js";
import {
  ANTIGRAVITY_INTEGRATION,
  antigravityLaunch,
  isAntigravityConfig,
  prepareAntigravityProfile,
} from "./antigravity-profile.js";
import {
  installAntigravityRuntime,
  latestAntigravityRelease,
  readAntigravityInstallation,
} from "./antigravity-install.js";
import { createAntigravityLogin } from "./antigravity-login.js";
import { changeNativeProvider } from "./provider-lifecycle.js";
import { probeNativeAgent, invalidateNativeAgent } from "./setup.js";

const requestSchema = z.object({
  action: z.enum([
    "status",
    "install",
    "check-update",
    "refresh",
    "login",
    "respond",
    "cancel",
    "enable",
    "disable",
    "sign-out",
  ]),
  flowId: z.string().uuid().optional(),
  response: z.string().min(1).max(16_384).optional(),
});

export function createAntigravityService(
  providersFilePath: string,
  settings: (options: { refreshCatalog: boolean }) => Promise<ProviderSettings>,
) {
  const home = dirname(providersFilePath);
  const providerId = ANTIGRAVITY_PROVIDER_ID;
  const runtime: AntigravityRuntimeState = {
    phase: "idle",
    version: null,
    latestVersion: null,
    downloadedBytes: 0,
    totalBytes: null,
    error: null,
  };
  const login = createAntigravityLogin();
  const shutdown = new AbortController();
  let installing: Promise<void> | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  let checked: { status: AntigravitySetupState["status"]; error: string | null } | null = null;
  const profileDirectory = () => join(home, "providers", "antigravity", randomUUID());

  async function config() {
    return (await readProvidersFile(providersFilePath)).providers[providerId];
  }
  async function snapshot(flowId?: string): Promise<AntigravitySetupState> {
    const [stored, installed] = await Promise.all([config(), readAntigravityInstallation(home)]);
    runtime.version = installed?.version ?? null;
    const hasLogin =
      stored?.sourceHome &&
      (await access(join(stored.sourceHome, "antigravity-acp", "acp_token.json")).then(
        () => true,
        () => false,
      ));
    return {
      runtime: { ...runtime },
      enabled: stored?.enabled ?? false,
      status: !installed
        ? "missing"
        : (checked?.status ?? (hasLogin ? "unavailable" : "needs_login")),
      error: checked?.error ?? null,
      login: login.snapshot(flowId),
    };
  }
  async function verify(signal?: AbortSignal, expectedInstanceId?: string) {
    const stored = await config();
    if (!stored || !isAntigravityConfig(stored))
      throw new Error("Install Antigravity before signing in.");
    if (
      expectedInstanceId &&
      antigravityLaunch(providerId, stored).instanceId !== expectedInstanceId
    )
      throw new Error("The Google account changed during sign-in. Start a fresh attempt.");
    const result = await probeNativeAgent(providerId, stored, { force: true, signal });
    checked = { status: result.status, error: result.error };
    if (result.status !== "ready")
      throw new Error(result.error ?? "Antigravity could not verify account access.");
    const identity = antigravityLaunch(providerId, stored).instanceId;
    await updateProvidersFile(providersFilePath, (current) => {
      signal?.throwIfAborted();
      const latest = current.providers[providerId];
      if (!latest || antigravityLaunch(providerId, latest).instanceId !== identity)
        throw new Error("The Google account changed during verification.");
      return mergeProviderConfigPatch({
        value: current,
        providerId,
        patch: { enabled: true },
        updatedAt: new Date().toISOString(),
      });
    });
  }
  async function registerRuntime() {
    const installed = await installAntigravityRuntime(home, runtime, shutdown.signal);
    runtime.phase = "installing";
    shutdown.signal.throwIfAborted();
    const prior = await config();
    const sourceHome = prior?.sourceHome ?? profileDirectory();
    await prepareAntigravityProfile(sourceHome);
    await updateProvidersFile(providersFilePath, (current) =>
      mergeProviderConfigPatch({
        value: current,
        providerId,
        patch: {
          sourceHome,
          acp: {
            displayName: "Google Antigravity",
            command: installed.command,
            args: [],
            env: {},
            registryId: ANTIGRAVITY_INTEGRATION,
            version: installed.version,
            installUrl: "https://antigravity.google/docs/",
            authMethodId: "oauth-personal",
          },
          enabled: prior?.enabled ?? false,
        },
        updatedAt: new Date().toISOString(),
      }),
    );
    checked = null;
    runtime.phase = "idle";
  }
  async function mutate(payload: unknown): Promise<AntigravitySetupState> {
    shutdown.signal.throwIfAborted();
    const request = requestSchema.parse(payload);
    if (request.action === "status") return snapshot(request.flowId);
    if (request.action === "install") {
      if (login.active)
        throw new Error("Finish or cancel Google sign-in before updating Antigravity.");
      if (!installing) {
        runtime.phase = "checking";
        installing = registerRuntime()
          .catch((error) => {
            runtime.phase = "failed";
            runtime.error =
              error instanceof Error ? error.message : "Could not install Antigravity.";
          })
          .finally(() => {
            installing = null;
          });
      }
      return snapshot(request.flowId);
    }
    if (installing) throw new Error("Wait for the Antigravity installation to finish.");
    if (request.action === "check-update") {
      runtime.latestVersion = (await latestAntigravityRelease(shutdown.signal)).version;
      return snapshot(request.flowId);
    }
    if (request.action === "login") {
      const stored = await config();
      if (!stored || !isAntigravityConfig(stored) || !(await readAntigravityInstallation(home)))
        throw new Error("Install Antigravity before signing in.");
      if (
        stored.sourceHome &&
        (await access(join(stored.sourceHome, "antigravity-acp", "acp_token.json")).then(
          () => true,
          () => false,
        ))
      )
        throw new Error("Sign out of the saved Google account before starting another sign-in.");
      await prepareAntigravityProfile(stored.sourceHome!);
      const launch = antigravityLaunch(providerId, stored);
      const flow = await login.start(launch, (signal) => verify(signal, launch.instanceId));
      return snapshot(flow.id);
    }
    if (request.action === "respond") {
      if (!request.flowId || !request.response)
        throw new Error("A current sign-in attempt and Google code are required.");
      login.submit(request.flowId, request.response);
      return snapshot(request.flowId);
    }
    if (request.action === "cancel") {
      if (!request.flowId) throw new Error("Choose the sign-in attempt to cancel.");
      await login.cancel(request.flowId);
      return snapshot(request.flowId);
    }
    if (request.action === "disable" || request.action === "sign-out") {
      await changeNativeProvider(providerId, async () => {
        await login.cancel();
        const stored = await config();
        if (!stored) return;
        const sourceHome = request.action === "sign-out" ? profileDirectory() : stored.sourceHome;
        if (request.action === "sign-out") await prepareAntigravityProfile(sourceHome!);
        if (request.action === "sign-out" && stored.sourceHome)
          await rm(join(stored.sourceHome, "antigravity-acp", "acp_token.json"), { force: true });
        await updateProvidersFile(providersFilePath, (current) => {
          const next = mergeProviderConfigPatch({
            value: current,
            providerId,
            patch: {
              enabled: false,
              sourceHome,
              ...(request.action === "sign-out"
                ? { defaultModel: null, nativeMode: null, nativeOptions: {}, modelOverrides: [] }
                : {}),
            },
            updatedAt: new Date().toISOString(),
          });
          if (request.action === "sign-out" && next.modelCaches)
            delete next.modelCaches[providerId];
          return next;
        });
        invalidateNativeAgent(
          antigravityLaunch(providerId, stored).instanceId,
          new Error("Google Antigravity was disconnected."),
        );
        checked = null;
      });
    } else if (request.action === "enable") {
      await verify(shutdown.signal);
    } else if (request.action === "refresh") {
      const stored = await config();
      if (stored && isAntigravityConfig(stored)) {
        const hasLogin =
          stored.sourceHome &&
          (await access(join(stored.sourceHome, "antigravity-acp", "acp_token.json")).then(
            () => true,
            () => false,
          ));
        if (hasLogin) {
          const result = await probeNativeAgent(providerId, stored, {
            force: true,
            signal: shutdown.signal,
          });
          checked = { status: result.status, error: result.error };
        } else checked = { status: "needs_login", error: null };
      }
    }
    return {
      ...(await snapshot(request.flowId)),
      settings: await settings({ refreshCatalog: false }),
    };
  }
  return {
    request(payload: unknown) {
      if (requestSchema.parse(payload).action === "status") return mutate(payload);
      const result = queue.then(() => mutate(payload));
      queue = result.catch(() => undefined);
      return result;
    },
    async close() {
      shutdown.abort();
      await login.close();
      await installing;
      await queue;
    },
  };
}
