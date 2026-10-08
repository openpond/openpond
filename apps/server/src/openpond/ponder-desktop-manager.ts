import { createPonderDesktopProjectService } from "./ponder-desktop-project-service.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { loadAuthenticatedOpenPondAccountContext } from "@openpond/runtime";
import type { AppPreferences, LocalManagedMessageTarget, Session } from "@openpond/contracts";
import type { FileOutputRef } from "@openpond/contracts";
import type { SqliteStore } from "../store/store.js";
import type { createSessionStore } from "../store/session-store.js";
import type { TurnRunner } from "../runtime/turns/ports.js";
import type { PonderInstallation } from "./ponder-installation.js";
import { createCapturedOpenPondPublicApiClient } from "./sandboxes.js";
import { ponderLocalOwner, type PonderLocalOwner } from "./ponder-local-scope.js";
import {
  capturePonderDesktopCatalog,
  ponderDesktopSessionRevision,
} from "./ponder-desktop-catalog.js";
import { ponderSessionMayAttach } from "../store/ponder-session-attachment.js";
import { capturePonderDesktopStarters } from "./ponder-desktop-starters.js";
import { createPonderDesktopClient } from "./ponder-desktop-client.js";
import { createPonderDesktopExecutor } from "./ponder-desktop-executor.js";
import { createPonderDesktopRuntime } from "./ponder-desktop-runtime.js";
import { createPonderDesktopResultCapture } from "./ponder-desktop-result-capture.js";
import { readPonderDesktopOutput } from "./ponder-desktop-output.js";
import type { createWorkOutputService } from "../work/work-output-service.js";

const BindingSchema = z.object({
  bindingId: z.string().min(1),
  bindingRevision: z.number().int().positive(),
  ownerUserId: z.string().min(1),
  teamId: z.string().min(1),
  conversationId: z.string().min(1),
});
type HostedRequest = {
  path: string;
  method?: "GET" | "POST";
  body?: Record<string, unknown>;
  idempotencyKey?: string;
};
const ownerKey = (owner: PonderLocalOwner) =>
  createHash("sha256").update(JSON.stringify(owner)).digest("hex");

/** The process owns this manager. Opening or hiding Ponder never owns its connection. */
export function createPonderDesktopManager(deps: {
  storeDir: string;
  installation: PonderInstallation;
  store: SqliteStore;
  sessions: Pick<ReturnType<typeof createSessionStore>, "createReservedSession">;
  runner: Pick<TurnRunner, "admitPonderLocalMessage" | "interruptSessionTurn">;
  loadAppPreferences(): Promise<AppPreferences>;
  providerSettings(): Promise<import("@openpond/contracts").ProviderSettings>;
  profileLibrary(): Promise<import("@openpond/contracts").OpenPondProfileLibrary>;
  localProjects(): Promise<import("@openpond/contracts").LocalProject[]>;
  inspect(id: string): Promise<LocalManagedMessageTarget>;
  outputs(sessionId: string, turnId: string): Promise<FileOutputRef[]>;
  readOutput: ReturnType<typeof createWorkOutputService>["readWorkOutput"];
  warn(message: string): void;
  relayRequest: NonNullable<Parameters<typeof createPonderDesktopClient>[0]["relayRequest"]>;
  relayWake(): void;
}) {
  let active: {
    key: string;
    credentialRevision: string;
    owner: PonderLocalOwner;
    conversationId: string;
    runtime: ReturnType<typeof createPonderDesktopRuntime>;
    client: ReturnType<typeof createCapturedOpenPondPublicApiClient>;
    valid: boolean;
  } | null = null;
  let closed = false;
  let authorityGeneration = 0;
  let disabled = new Set<string>();
  let reauthorizations: Record<string, number> = {};
  let timer: ReturnType<typeof setTimeout> | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  const file = path.join(deps.storeDir, "ponder-installation", "link-state.json");
  function serial<T>(action: () => Promise<T>): Promise<T> {
    const result = queue.then(action);
    queue = result.catch(() => undefined);
    return result;
  }
  async function current() {
    const context = await loadAuthenticatedOpenPondAccountContext();
    const teamId = (await deps.loadAppPreferences()).defaultTeamId;
    if (!teamId || context.accountState.state !== "signed_in") return null;
    const client = createCapturedOpenPondPublicApiClient(context, teamId);
    const owner = ponderLocalOwner(
      context,
      deps.installation.installationId,
      teamId,
      client.audience,
    );
    const credentialRevision = createHash("sha256")
      .update(JSON.stringify([context.token, context.apiBaseUrl]))
      .digest("hex");
    return owner ? { owner, key: ownerKey(owner), credentialRevision, client } : null;
  }
  const projectService = createPonderDesktopProjectService({
    store: deps.store,
    loadProjects: deps.localProjects,
    preferences: deps.loadAppPreferences,
    current: async () => {
      const selected = await current(),
        connection = active;
      const status = connection?.runtime.status();
      if (
        closed ||
        !selected ||
        !connection?.valid ||
        connection.key !== selected.key ||
        connection.credentialRevision !== selected.credentialRevision ||
        (status?.state !== "online" && status?.state !== "idle") ||
        !status.authorizationRevision
      )
        return null;
      return {
        owner: selected.owner,
        credentialKey: `${selected.key}:${selected.credentialRevision}`,
        authority: { scope: status.scope, authorizationRevision: status.authorizationRevision },
      };
    },
  });
  async function persistDisabled() {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(
      temporary,
      JSON.stringify({ version: 1, disabled: [...disabled], reauthorizations }),
      {
        mode: 0o600,
      },
    );
    await rename(temporary, file);
  }
  async function disconnect(revoke = false) {
    const previous = active;
    if (previous) previous.valid = false;
    active = null;
    if (previous) {
      if (revoke) await previous.runtime.revoke();
      await previous.runtime.close();
    } else await deps.store.clearPonderDesktopAuthority();
  }
  async function reconcile() {
    if (closed) return;
    const selected = await current();
    if (active && (!selected || active.key !== selected.key)) {
      active.valid = false;
      reauthorizations[active.key] = (reauthorizations[active.key] ?? 0) + 1;
      await persistDisabled();
      await disconnect(true);
    }
    if (!selected || disabled.has(selected.key)) {
      await disconnect();
      return;
    }
    if (
      active?.key === selected.key &&
      active.credentialRevision === selected.credentialRevision &&
      active.valid
    )
      return;
    await disconnect();
    const binding = BindingSchema.parse(
      await selected.client.request({ path: "/ponder", method: "POST" }),
    );
    const client = createPonderDesktopClient({
      installation: deps.installation,
      owner: selected.owner,
      client: selected.client,
      binding,
      relayRequest: deps.relayRequest,
    });
    const capture = async () => {
      // Authoritative session records contain ownership; sidebar projections do not grant authority.
      const shells = await deps.store.sessionShells();
      const sessions = (
        await Promise.all(shells.map((session) => deps.store.getSession(session.id)))
      ).filter((session): session is Session => session !== null);
      const status = connection.runtime.status();
      if (!status.authorizationRevision)
        throw new Error("ponder_desktop_project_authority_changed");
      const sharedProjects = await projectService.workspaces(selected.owner, {
        scope: status.scope,
        authorizationRevision: status.authorizationRevision,
      });
      const starters = await capturePonderDesktopStarters({
        owner: selected.owner,
        sessions,
        projectWorkspaces: sharedProjects.workspaces,
        blockedProjects: sharedProjects.blockedProjects,
        providers: await deps.providerSettings(),
        profiles: (await deps.profileLibrary()).profiles,
      });
      const catalog = await capturePonderDesktopCatalog({
        owner: selected.owner,
        sessions,
        inspect: deps.inspect,
        starters: [...starters.values()].map((starter) => starter.target),
      });
      return { catalog, starters };
    };
    const executor = createPonderDesktopExecutor({
      store: deps.store,
      admit: (input) => deps.runner.admitPonderLocalMessage(input),
      interrupt: (...args) => deps.runner.interruptSessionTurn(...args),
      createReserved: (...args) => deps.sessions.createReservedSession(...args),
      resolveStarter: async (target) => {
        const starter = (await capture()).starters.get(target.id);
        if (!starter || starter.target.revision !== target.revision)
          throw new Error("ponder_desktop_starter_target_changed");
        return starter.payload;
      },
    });
    const connection = {
      key: selected.key,
      credentialRevision: selected.credentialRevision,
      owner: selected.owner,
      conversationId: binding.conversationId,
      client: selected.client,
      valid: true,
      runtime: null as unknown as ReturnType<typeof createPonderDesktopRuntime>,
    };
    connection.runtime = createPonderDesktopRuntime({
      client,
      owner: selected.owner,
      publicKey: deps.installation.publicKey,
      reauthorizationGeneration: reauthorizations[selected.key] ?? 0,
      catalog: async () => (await capture()).catalog,
      stillOwned: async () => {
        if (!connection.valid || closed) return false;
        const selectedNow = await current();
        return (
          selectedNow?.key === selected.key &&
          selectedNow.credentialRevision === selected.credentialRevision
        );
      },
      setAuthority: (attachment) => deps.store.setPonderDesktopAuthority(attachment),
      clearAuthority: (id) => deps.store.clearPonderDesktopAuthority(id),
      recover: executor.recover,
      reservation: executor.reservation,
      execute: executor.execute,
      result: createPonderDesktopResultCapture({
        store: deps.store,
        outputs: deps.outputs,
      }),
      inspection: async (operation) => {
        const record = await deps.store.getPonderDesktopInspection(operation.id);
        if (record && record.operation.payloadHash !== operation.payloadHash)
          throw new Error("ponder_desktop_inspection_identity_changed");
        return record?.inspection ?? null;
      },
      warn: deps.warn,
    });
    active = connection;
    await connection.runtime
      .start()
      .catch((error) => deps.warn(`Ponder desktop startup: ${String(error)}`));
  }
  function schedule() {
    if (closed) return;
    timer = setTimeout(
      () =>
        void serial(reconcile)
          .catch((error) => deps.warn(`Ponder desktop: ${String(error)}`))
          .finally(schedule),
      15_000,
    );
    timer.unref();
  }
  return {
    relayAuthority(deviceId: string, genericRuntimeId: string) {
      return active?.valid ? active.runtime.relayAuthority(deviceId, genericRuntimeId) : null;
    },
    needsRelay: () => !!active?.valid && active.runtime.needsConnection(),
    receiveOperations(payload: unknown, hasObligations: boolean) {
      if (!active?.valid) throw new Error("ponder_relay_authority_unavailable");
      active.runtime.receiveOperations(payload, hasObligations);
    },
    async start() {
      await deps.store.clearPonderDesktopAuthority();
      try {
        const value = z
          .object({
            version: z.literal(1),
            disabled: z.array(z.string().regex(/^[a-f0-9]{64}$/)),
            reauthorizations: z
              .record(z.string().regex(/^[a-f0-9]{64}$/), z.number().int().nonnegative())
              .default({}),
          })
          .parse(JSON.parse(await readFile(file, "utf8")));
        disabled = new Set(value.disabled);
        reauthorizations = value.reauthorizations;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await serial(reconcile).catch((error) =>
        deps.warn(`Ponder desktop startup: ${String(error)}`),
      );
      schedule();
    },
    async close() {
      authorityGeneration++;
      closed = true;
      if (timer) clearTimeout(timer);
      if (active) active.valid = false;
      await deps.store.clearPonderDesktopAuthority();
      await serial(disconnect);
    },
    async beforeAuthorityChange() {
      authorityGeneration++;
      if (active) active.valid = false;
      // Fence immediately, before the account/team mutation, even while a cloud request is in flight.
      await deps.store.clearPonderDesktopAuthority();
      const key = active?.key ?? (await current())?.key;
      await serial(async () => {
        if (key) {
          reauthorizations[key] = (reauthorizations[key] ?? 0) + 1;
          await persistDisabled();
        }
        await disconnect(true);
      });
    },
    async connection(action: "status" | "link" | "unlink") {
      return serial(async () => {
        const selected = await current();
        if (action === "unlink" && selected) {
          disabled.add(selected.key);
          reauthorizations[selected.key] = (reauthorizations[selected.key] ?? 0) + 1;
          await persistDisabled();
          await disconnect(true);
        }
        if (action === "link" && selected) {
          disabled.delete(selected.key);
          await persistDisabled();
          await reconcile();
        }
        const candidates = [];
        if (selected) {
          for (const shell of await deps.store.sessionShells()) {
            const session = await deps.store.getSession(shell.id);
            if (!session || !ponderSessionMayAttach(session)) continue;
            const managed = await deps.inspect(session.id);
            if (!managed.canSendFollowup) continue;
            candidates.push({
              id: session.id,
              title: session.title,
              revision: ponderDesktopSessionRevision(session, managed.latestTurnId),
            });
          }
        }
        return {
          ...(active?.runtime.status() ?? {
            state: selected && disabled.has(selected.key) ? "unlinked" : "offline",
            scope: null,
            leaseExpiresAt: null,
          }),
          ownerScope: selected?.owner ?? null,
          attachableSessions: candidates,
        };
      });
    },
    projects(after: string | null = null) {
      return serial(() => projectService.list(after));
    },
    shareProject(payload: unknown) {
      return serial(async () => {
        if (active?.valid) await active.runtime.refresh();
        const result = await projectService.change(payload);
        const connection = active;
        if (!connection?.valid) return { ...result, discovery: "pending" as const };
        try {
          await connection.runtime.refresh();
          if (!connection.valid || active !== connection)
            throw new Error("ponder_desktop_project_authority_changed");
          return { ...result, discovery: "current" as const };
        } catch (error) {
          deps.warn(`Ponder project discovery refresh: ${String(error)}`);
          return { ...result, discovery: "pending" as const };
        }
      });
    },
    attachSession(payload: unknown) {
      return serial(async () => {
        const generation = authorityGeneration;
        const input = z
          .object({
            sessionId: z.string().min(1).max(200),
            expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict()
          .parse(payload);
        const selected = await current();
        if (!selected)
          throw new Error("Sign in and select a workspace before attaching a local task.");
        const managed = await deps.inspect(input.sessionId);
        if (!managed.canSendFollowup) throw new Error("ponder_desktop_attach_session_unavailable");
        const latest = await current();
        if (
          closed ||
          generation !== authorityGeneration ||
          latest?.key !== selected.key ||
          latest.credentialRevision !== selected.credentialRevision
        )
          throw new Error("ponder_desktop_attach_session_owner_changed");
        const session = await deps.store.attachPonderSessionOwner({
          ...input,
          owner: selected.owner,
          assertCurrent: () => {
            if (closed || generation !== authorityGeneration)
              throw new Error("ponder_desktop_attach_session_owner_changed");
          },
        });
        return { sessionId: session.id, title: session.title, attached: true };
      });
    },
    request(request: HostedRequest) {
      return serial(async () => {
        await reconcile();
        const selected = await current();
        if (!selected) throw new Error("Sign in and select a workspace before using Ponder.");
        if (request.path === "/ponder/desktop/outputs" && request.method === "POST") {
          const connection = active;
          const scope = connection?.runtime.status().scope;
          if (
            !connection?.valid ||
            connection.key !== selected.key ||
            connection.credentialRevision !== selected.credentialRevision ||
            !scope
          )
            throw new Error("ponder_desktop_output_connection_unavailable");
          const result = await readPonderDesktopOutput(
            {
              store: deps.store,
              owner: selected.owner,
              scope,
              readOutput: deps.readOutput,
            },
            request.body,
          );
          const latest = await current();
          if (
            closed ||
            active !== connection ||
            !connection.valid ||
            latest?.key !== selected.key ||
            latest.credentialRevision !== selected.credentialRevision
          )
            throw new Error("ponder_desktop_output_owner_changed");
          return result;
        }
        let wakeAfterRequest: (() => void) | null = null;
        const body = { ...request.body };
        // Renderer-supplied desktop authority is never forwarded or signed.
        delete body.desktopProof;
        if (
          request.method === "POST" &&
          active?.valid &&
          active.key === selected.key &&
          request.path === `/conversations/${active.conversationId}/turns`
        ) {
          if (!request.idempotencyKey) throw new Error("idempotency_key_required");
          const connection = active;
          await connection.runtime.refresh();
          const latest = await current();
          if (
            !connection.valid ||
            active !== connection ||
            latest?.key !== selected.key ||
            latest.credentialRevision !== selected.credentialRevision
          )
            throw new Error("ponder_desktop_runtime_owner_changed");
          wakeAfterRequest = () => connection.runtime.wake();
          const proof = connection.runtime.proofForHumanTurn(
            request.path,
            body,
            request.idempotencyKey,
          );
          if (!proof) throw new Error("ponder_desktop_connection_unavailable");
          body.desktopProof = proof;
        }
        try {
          return await selected.client.request({
            ...request,
            ...(request.body ? { body } : {}),
          });
        } finally {
          // The hosted admission may commit even if the response is lost.
          wakeAfterRequest?.();
          deps.relayWake();
        }
      });
    },
  };
}
