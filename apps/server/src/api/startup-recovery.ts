import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import {
  MigrationResolutionsSchema, initializeHome, resolveEffectiveConfig, readMigrationJournal, persistenceIssue,
  PersistenceError, storagePaths, restartMigration,
} from "@openpond/persistence";
import { ensureCapabilityToken } from "../paths.js";
import { VERSION } from "../constants.js";
import { ownHomeRuntime, publishRuntimeEndpoint } from "../runtime/home-runtime-owner.js";
import { createConfigurationPayloads } from "./configuration-payloads.js";
import { applyCorsHeaders, hasAuth, readJson, sendJson } from "./http.js";
import { startupRecoveryPage } from "./startup-recovery-page.js";

const recoveryRequest = z.strictObject({ action: z.enum(["preview", "migrate", "restart", "retry"]), sourceAppHome: z.string().optional(), sourceConfig: z.string().optional(), resolutions: MigrationResolutionsSchema.optional() });
export function isRecoverableStartupError(error: unknown): error is PersistenceError {
  return error instanceof PersistenceError && /^(PRIVATE_STORAGE_|UNSAFE_STORAGE_|INVALID_CONFIG|CONFIG_|MIGRATION_|SOURCE_CHANGED_|CREDENTIAL_|UNSUPPORTED_STORAGE_|INVALID_MIGRATION_|INVALID_ACCOUNT_|MISSING_INSTRUCTION_|INVALID_PROFILE_|DATABASE_RECOVERY_)/.test(error.issue.code);
}
export async function startRecoveryServer(home: string, port: number, initialError: PersistenceError) {
  const readOnlyHome = /^(UNSUPPORTED_STORAGE_|INVALID_MIGRATION_|UNSAFE_STORAGE_|PRIVATE_STORAGE_)/.test(initialError.issue.code);
  const runtimeHome = readOnlyHome ? await fs.mkdtemp(path.join(os.tmpdir(), "openpond-recovery-")) : home;
  return ownHomeRuntime(runtimeHome, async () => {
    const { token, tokenFile } = await ensureCapabilityToken(runtimeHome);
    const configuration = createConfigurationPayloads(home);
    let issue = initialError.issue;
    let ready!: () => void;
    const repaired = new Promise<void>((resolve) => { ready = resolve; });
    const server = createServer((request, response) => {
      void (async () => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (!applyCorsHeaders(request, response).allowed) { sendJson(response, 403, { error: "Origin not allowed" }); return; }
        if (request.method === "OPTIONS") { sendJson(response, 204, {}); return; }
        if (request.method === "GET" && url.pathname === "/health") { sendJson(response, 200, { ok: true, server: "openpond-app-server", version: VERSION, recovery: true }); return; }
        if (request.method === "GET" && url.pathname === "/") {
          const nonce = randomBytes(18).toString("base64");
          response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'` });
          response.end(startupRecoveryPage(nonce)); return;
        }
        if (!hasAuth(request, url, token)) { sendJson(response, 401, { error: "Unauthorized" }); return; }
        const configEditable = !readOnlyHome;
        if (request.method === "GET" && url.pathname === "/v1/recovery") {
          sendJson(response, 200, { issue, configEditable, config: readOnlyHome ? { path: storagePaths(home).config, text: null, rawRevision: "unavailable", issue, recoverableRevisions: [] } : await configuration.status(), migration: await readMigrationJournal(home).catch((error) => ({ issue: persistenceIssue(error, home) })) }); return;
        }
        if (request.method === "POST" && url.pathname === "/v1/configuration" && configEditable) {
          sendJson(response, 200, await configuration.mutate(await readJson(request))); return;
        }
        if (request.method === "POST" && url.pathname === "/v1/recovery") {
          const input = recoveryRequest.parse(await readJson(request));
          if (readOnlyHome && input.action !== "retry" && input.action !== "preview") throw initialError;
          if (input.action === "restart") { sendJson(response, 200, await restartMigration(home)); return; }
          if (input.action === "preview" || input.action === "migrate") { sendJson(response, 200, await initializeHome(home, { sourceAppHome: input.sourceAppHome, sourceConfig: input.sourceConfig, resolutions: input.resolutions, dryRun: input.action === "preview" })); return; }
          await initializeHome(home);
          await resolveEffectiveConfig(home);
          sendJson(response, 200, { ready: true }); ready(); return;
        }
        sendJson(response, 503, { error: `${issue.message} ${issue.action}`, issue, recovery: true });
      })().catch((error) => { issue = persistenceIssue(error, home); sendJson(response, 422, { error: `${issue.message} ${issue.action}`, issue }); });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
    const actualPort = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${actualPort}`;
    await publishRuntimeEndpoint(runtimeHome, url, "startup-recovery");
    return { url, port: actualPort, token, tokenFile, storePath: storagePaths(home).database, repaired,
      close: async () => { server.closeIdleConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); if (readOnlyHome) await fs.rm(runtimeHome, { recursive: true, force: true }); } };
  }).catch(async (error) => { if (readOnlyHome) await fs.rm(runtimeHome, { recursive: true, force: true }); throw error; });
}
