import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { loadOpenPondAccountContext } from "@openpond/runtime";
import { getOpenPondAccount } from "@openpond/cloud";
import { toAccountState } from "../../packages/runtime/src/account-state.js";
import type { RemoteDispatchCommand, RemoteTask, RemoteCommandReceipt, LocalManagedMessageTarget } from "@openpond/contracts";
import { SqliteStore } from "../../apps/server/src/store/store.js";
import { createSessionStore } from "../../apps/server/src/store/session-store.js";
import { createRemoteRelayManager } from "../../apps/server/src/remote-relay/manager.js";
import { createRemoteCommandExecutor } from "../../apps/server/src/remote-relay/executor.js";
import { loadDeviceInstallation } from "../../apps/server/src/remote-relay/installation.js";
import { deviceLocalOwner } from "../../apps/server/src/remote-relay/local-scope.js";
import { localSessionOwnershipRevision } from "../../apps/server/src/remote-relay/session-ownership.js";
import { createCapturedOpenPondPublicApiClient } from "../../apps/server/src/openpond/sandboxes.js";

// Manual proof: real staging dispatch enters Native's canonical SQLite admission.
// An isolated store has no turn runner, so no provider is invoked or charged.
assert(process.argv.includes("--staging"), "Explicit --staging required");
const option = (name: string, fallback: string) => { const index = process.argv.indexOf(name); return index < 0 ? fallback : process.argv[index + 1]!; };
const teamId = option("--team-id", "a3v5vj0bxfyphbgihbgprm6f");
const handle = option("--profile", "ponder-staging-qa");
const sandbox = path.resolve(option("--sandbox", "../sandbox"));
const directory = await mkdtemp(path.join(os.tmpdir(), "native-relay-staging-"));
const evidencePath = path.resolve(option("--output", "docs/working-docs/server/evidence/remote-device-native-staging.json"));
const checks: Record<string, unknown>[] = [];
const evidence: Record<string, unknown> = { capturedAt: new Date().toISOString(), api: "https://staging-api.openpond.ai", nativeCanonicalAdmission: true,
  installedDesktopQualified: false, providerInvocations: 0, isolatedStore: true,
  sources: { native: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    sandbox: execFileSync("git", ["rev-parse", "HEAD"], { cwd: sandbox, encoding: "utf8" }).trim() }, checks };
let store = new SqliteStore(directory);
let manager: ReturnType<typeof createRemoteRelayManager> | null = null;
let helper: ReturnType<typeof spawn> | null = null;
let sourceDevice: { id: string; revision: number } | null = null;
let human: (route: string, method?: string, payload?: unknown) => Promise<any>;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor<T>(read: () => Promise<T | null | undefined>, label: string, seconds = 45): Promise<T> {
  for (let attempt = 0; attempt < seconds * 5; attempt++) { const value = await read(); if (value) return value; await pause(200); }
  throw new Error(`Timed out: ${label}`);
}
try {
  const captured = await loadOpenPondAccountContext(handle, "https://staging.openpond.ai");
  assert.equal(new URL(captured.apiBaseUrl).origin, "https://staging-api.openpond.ai");
  assert(captured.token, "Saved staging credentials required");
  const response = await getOpenPondAccount(captured.apiBaseUrl, captured.token);
  const context = { ...captured, accountState: toAccountState({ ...captured, accountResponse: response }) };
  assert.equal(context.accountState.profile?.id, "dzdaskv4w4", "Qualification owner changed");
  const client = createCapturedOpenPondPublicApiClient(context, teamId);
  const installation = await loadDeviceInstallation(directory);
  const owner = deviceLocalOwner(context, installation.installationId, teamId, client.audience)!;
  assert(owner);
  evidence.scope = { ownerUserId: owner.ownerUserId, teamId, installationId: owner.installationId, profileId: owner.profileId };
  const sessions = createSessionStore({ store, defaultSessionCwd: () => directory, appendRuntimeEvent: event => store.appendRuntimeEvent(event).then(() => {}), captureUserOwner: async () => owner });
  const session = await sessions.createUserSession({ provider: "codex", title: "Native staging admission qualification", cwd: directory });
  evidence.localSessionId = session.id;
  const selected = { owner, credentialKey: createHash("sha256").update(context.token!).digest("hex"), request: client.request };
  const inspect = async (id: string): Promise<LocalManagedMessageTarget> => ({ sessionId: id, provider: session.provider, title: session.title,
    targetRevision: localSessionOwnershipRevision(session, null), managedSessionId: null, latestTurnId: null, activeTurnId: null,
    paused: false, approvalBlocked: false, canSendFollowup: true, canSteer: false, unavailableReason: null, inbox: await store.taskInboxSnapshot(id) });
  const commands = new Map<string, RemoteDispatchCommand>();
  let dropNextReceipt = false;
  let droppedCommand: RemoteDispatchCommand | null = null;
  const createManager = () => {
    const execute = createRemoteCommandExecutor({ store, inspect, admit: input => store.admitTaskInput(input), interrupt: async () => null });
    return createRemoteRelayManager({ storeDir: directory, installation, store, current: async () => selected, accountStatus: async () => ({ state: selected ? "ready" as const : "signed_out" as const, account: selected ? { id: owner.ownerUserId, label: owner.ownerUserId } : null, team: selected?.owner.teamId ? { id: selected.owner.teamId } : null, webBaseUrl: "https://staging.openpond.ai" }), inspect,
      execute: async command => { commands.set(command.id, command); const receipt = await execute(command);
        if (dropNextReceipt) { dropNextReceipt = false; droppedCommand = command; await manager!.beforeAuthorityChange(); }
        return receipt; },
      outputs: async () => [], readOutput: async () => { throw new Error("No qualification artifacts"); }, listen: () => () => {},
      warn: message => { if (process.argv.includes("--verbose")) console.error(message.replace(/Bearer\s+\S+/g, "Bearer [redacted]")); } });
  };
  const helperFile = path.join(directory, "human-helper.ts");
  await writeFile(helperFile, `import { buildRemoteWebSessionHeaders } from ${JSON.stringify(path.join(sandbox,"lib/remote-devices/web-session-headers.ts"))};
import { accessLatestGcpSecret } from ${JSON.stringify(path.join(sandbox,"scripts/cli/gcp-secret-manager.ts"))};
process.env.CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE='/home/glu/.config/gcloud/application_default_credentials.json';
delete process.env.CLOUDSDK_AUTH_ACCESS_TOKEN;
Object.assign(process.env,{OPENPOND_ENV:'staging',APP_ENV:'staging',ENVIRONMENT:'staging'});
process.env.OPENPOND_SERVICE_AUTH_SECRET=await accessLatestGcpSecret({projectId:'openpond',secretId:'openpond-staging-service-auth'});
for await (const line of console){try{const input=JSON.parse(line);const body=input.payload===undefined?'':JSON.stringify(input.payload);
const headers=buildRemoteWebSessionHeaders({userId:input.userId,teamId:input.teamId,method:input.method,path:input.route,body,origin:'https://staging.openpond.ai'});
const response=await fetch('https://staging-api.openpond.ai'+input.route,{method:input.method,headers:{...headers,origin:'https://staging.openpond.ai','content-type':'application/json'},...(body?{body}:{}),redirect:'error',signal:AbortSignal.timeout(15000)});
console.log(JSON.stringify({id:input.id,status:response.status,body:await response.json()}));}catch{console.log(JSON.stringify({error:'human-helper-failed'}));}}`);
  helper = spawn("bun", ["--tsconfig-override", path.join(sandbox, "tsconfig.json"), helperFile], { cwd: sandbox, env: { ...process.env, CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: "/home/glu/.config/gcloud/application_default_credentials.json", CLOUDSDK_AUTH_ACCESS_TOKEN: "" }, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<string, { resolve(v: any): void; reject(e: Error): void }>();
  createInterface({ input: helper.stdout! }).on("line", line => { try { const value = JSON.parse(line); const entry = pending.get(value.id); if (entry) { pending.delete(value.id); entry.resolve(value); } } catch {} });
  let helperError = "";
  helper.stderr!.on("data", chunk => { helperError = (helperError + String(chunk)).slice(-4000); });
  helper.on("exit", code => { const category = helperError.includes("Operator ADC unavailable") ? "operator_adc_unavailable"
    : helperError.includes("Could not access GCP secret") ? "service_auth_secret_access_denied"
    : helperError.includes("Cannot find module") ? "module_not_found"
    : helperError.includes("postgres") || helperError.includes("Postgres") ? "unexpected_database_import"
    : "helper_startup_failed";
    evidence.humanHelperFailure = { code, category };
    for (const entry of pending.values()) entry.reject(new Error(`Human request helper exited: ${category}`)); });
  human = (route, method = "GET", payload) => new Promise((resolve, reject) => { const id = randomUUID();
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error("Human request timeout")); }, 20000);
    pending.set(id, { resolve: result => { clearTimeout(timeout);
    if (result.status < 200 || result.status >= 300) reject(new Error(`Human ${method} ${route}: HTTP ${result.status} ${result.body?.error ?? ''}`)); else resolve(result.body); }, reject: error => { clearTimeout(timeout); reject(error); } });
    helper!.stdin!.write(JSON.stringify({ id, route, method, payload, userId: owner.ownerUserId, teamId }) + "\n"); });
  manager = createManager(); await manager.start();
  sourceDevice = await waitFor(async () => manager!.status().state === "connected" ? manager!.status().device : null, "Native staging connected");
  const task = await waitFor(async () => (await human(`/v1/remote-devices/${sourceDevice!.id}/tasks`)).tasks.find((task: RemoteTask) => task.localSessionId === session.id), "Native catalog visible") as RemoteTask;
  checks.push({ name: "real_staging_enrollment_and_catalog", deviceId: sourceDevice.id, taskId: task.id, passed: true });
  const payload = { idempotencyKey: randomUUID(), action: "follow_up", targetId: task.id, expectedRevision: task.revision, expectedTurnId: null, payload: { text: "Native canonical admission proof, no provider execution" } };
  const started = Date.now();
  const submitted = (await human(`/v1/remote-devices/${sourceDevice.id}/commands`, "POST", payload)).receipt as RemoteCommandReceipt;
  const accepted = await waitFor(() => store.getRemoteDeviceReceipt(submitted.id), "Native persisted receipt");
  const replay = (await human(`/v1/remote-devices/${sourceDevice.id}/commands`, "POST", payload)).receipt as RemoteCommandReceipt;
  assert.equal(replay.id, accepted.id);
  const inputs = await store.taskInputsForSession(session.id, { limit: 10 });
  assert.equal(inputs.length, 1); assert.equal(inputs[0]!.id, accepted.inputId);
  const verified = commands.get(submitted.id)!; assert(verified.permit.signature); assert.equal(verified.actor, "remote-human");
  checks.push({ name: "real_signed_dispatch_native_sqlite_admission_duplicate", commandId: accepted.id, inputId: accepted.inputId, localSessionId: accepted.localSessionId,
    permitKeyId: verified.permit.keyId, fence: verified.fence, uniqueTaskInputs: inputs.length, elapsedMs: Date.now() - started, passed: true });
  dropNextReceipt = true;
  const lost = (await human(`/v1/remote-devices/${sourceDevice.id}/commands`, "POST", { ...payload, idempotencyKey: randomUUID(), payload: { text: "Lost receipt Native restart recovery" } })).receipt as RemoteCommandReceipt;
  await waitFor(async () => droppedCommand, "Lost receipt admitted");
  const before = await store.getRemoteDeviceReceipt(lost.id); assert(before?.inputId);
  await manager.close(); await store.close();
  store = new SqliteStore(directory); await store.initializeRemoteDeviceStore();
  const recovery = createRemoteCommandExecutor({ store, inspect: async () => { throw new Error("Recovery must not recheck readiness"); },
    admit: async () => { throw new Error("Recovery must not readmit"); }, interrupt: async () => null });
  const recovered = await recovery(droppedCommand!); assert.equal(recovered.inputId, before.inputId);
  assert.equal((await store.taskInputsForSession(session.id, { limit: 10 })).length, 2);
  manager = createManager(); await manager.start();
  await waitFor(async () => manager!.status().state === "connected" ? true : null, "Native restart reconnect");
  const hostedRecovered = await waitFor(async () => { const receipt = (await human(`/v1/remote-devices/${sourceDevice!.id}/commands/${lost.id}`)).receipt;
    return ["admitted", "applied"].includes(receipt.state) ? receipt : null; }, "Hosted recovered original Native receipt", 50);
  assert.equal(hostedRecovered.inputId, before.inputId);
  checks.push({ name: "lost_receipt_restart_exact_input_recovery", commandId: lost.id, inputId: before.inputId, uniqueTaskInputs: 2,
    originalFence: droppedCommand!.fence, newFence: commands.get(lost.id)?.fence, hostedState: hostedRecovered.state, passed: true });
  await manager.settings("status"); await manager.setEnabled(false);
  await assert.rejects(human(`/v1/remote-devices/${sourceDevice.id}/commands`, "POST", { ...payload, idempotencyKey: randomUUID() }), /remote_access_off/);
  await manager.close(); manager = createManager(); await manager.start();
  assert.equal(manager.status().enabled, false);
  const afterOff = await store.taskInputsForSession(session.id, { limit: 10 }); assert.equal(afterOff.length, 2);
  checks.push({ name: "persistent_off_restart_hosted_admission_denial", uniqueTaskInputs: afterOff.length, passed: true });
  evidence.completed = true;
} catch (error) { evidence.completed = false; evidence.connectionState = manager?.status().state; evidence.enrolledDeviceId = manager?.status().device?.id; evidence.error = error instanceof Error ? error.message : "qualification_failed"; throw error; }
finally {
  if (manager) {
    if (sourceDevice || manager.status().device) { try {
      await manager.settings("status"); const currentDevice = manager.status().device;
      if (currentDevice) await manager.settings("remove", { deviceId: currentDevice.id, revision: currentDevice.revision });
      evidence.cleanup = { deviceRemoved: true };
    } catch { evidence.cleanup = { deviceRemoved: false, requiresOwnerCleanup: sourceDevice?.id ?? manager.status().device?.id }; } }
    await manager.close().catch(() => {});
  }
  helper?.kill(); await store.close().catch(() => {});
  await mkdir(path.dirname(evidencePath), { recursive: true }); await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
  await rm(directory, { recursive: true, force: true });
  console.log(JSON.stringify({ evidencePath, completed: evidence.completed, checkCount: checks.length, providerInvocations: 0 }));
}
