import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, vi } from "vitest";
import { CodexAppServerClient } from "@openpond/codex-provider";
import { readProvidersFile, writeProvidersFile, normalizeProvidersFile } from "../../apps/server/src/openpond/provider-settings.js";
import { createTurnRunner } from "../../apps/server/src/runtime/turn-runner.js";
import type { RuntimeCodexSession } from "../../apps/server/src/types.js";
import { createLocalManagedMessaging } from "../../apps/server/src/runtime/task-inbox/local-managed-messaging.js";
import { createLocalManagedReadiness } from "../../apps/server/src/runtime/task-inbox/local-managed-readiness.js";
import { createTurnRunnerTestHarness, turnRunnerTestSession } from "./turn-runner-test-harness.js";

/** Explicit opt-in only: exercises installed agents in newly owned conversations. */
export async function qualifyLocalManagedMessaging(provider: "claude-code" | "opencode" | "codex") {
  const directory = await mkdtemp(join(tmpdir(), `openpond-managed-${provider}-`));
  const sessionId = `local-message-qualification-${provider}-${randomUUID()}`;
  const marker = `MEMORY_${randomUUID().replaceAll("-", "")}`;
  const followupMarker = `QUEUED_${randomUUID().replaceAll("-", "")}`;
  const steerMarker = `STEER_${randomUUID().replaceAll("-", "")}`;
  const clients = new Map<string, RuntimeCodexSession>();
  const source = await readProvidersFile(join(process.env.OPENPOND_QUALIFICATION_HOME ?? join(homedir(), ".openpond", "openpond-app-dev"), "providers.json"));
  const version = (await promisify(execFile)(provider === "codex" ? process.env.CODEX_BINARY ?? "codex" : source.providers[provider]?.binaryPath ?? (provider === "claude-code" ? "claude" : "opencode"), ["--version"], { timeout: 10_000 })).stdout.trim();
  await writeProvidersFile(join(directory, "providers.json"), normalizeProvidersFile({ providers: provider === "codex" ? {} : { [provider]: source.providers[provider] } }));
  const harness = createTurnRunnerTestHarness({ sessions: [turnRunnerTestSession({
    id: sessionId, title: `Controlled local messaging qualification (${provider})`, experience: provider === "codex" ? "development" : "chat", provider,
    modelRef: provider === "opencode" ? { providerId: "opencode", modelId: "openai/gpt-5.6-luna" } : null, cwd: directory,
  })], dependencies: { storageHome: directory, defaultSessionCwd: () => directory,
    ensureCodexRuntime: async (session, settings) => {
      const cached = clients.get(session.id);
      if (cached) return cached;
      const client = new CodexAppServerClient({
        onNotification(notification) {
          if (notification.method !== "item/agentMessage/delta") return;
          const params = notification.params as { delta?: string };
          if (params.delta) harness.state.events.push({ id: randomUUID(), name: "assistant.delta", sessionId,
            turnId: harness.state.turns.findLast((turn) => turn.sessionId === sessionId && turn.status === "in_progress")?.id,
            source: "provider", timestamp: new Date().toISOString(), output: params.delta });
        },
        onServerRequest: async () => ({ error: { code: -32000, message: "Qualification does not authorize unrelated tools." } }),
      });
      const config = { model_reasoning_effort: "low" };
      const thread = session.codexThreadId
        ? await client.resumeThread({ threadId: session.codexThreadId, cwd: directory, approvalPolicy: "never", sandbox: "read-only", config })
        : await client.startThread({ cwd: directory, approvalPolicy: "never", sandbox: "read-only", config,
          developerInstructions: "This is an isolated messaging qualification. Respond only to the supplied prompts. Do not access files or invoke tools unless the prompt explicitly requires it." });
      await harness.dependencies.updateSession(session.id, { codexThreadId: thread.threadId });
      const runtime = { client, threadId: thread.threadId, cwd: directory, permissionMode: settings.codexPermissionMode, reasoningEffort: settings.codexReasoningEffort ?? null };
      clients.set(session.id, runtime);
      return runtime;
    },
  } });
  let runner = harness.runner;
  const messageService = () => createLocalManagedMessaging({ store: harness.dependencies.store,
    getSession: harness.dependencies.getSession, latestTurn: (id) => harness.dependencies.store.latestTurnForSession(id),
    readiness: createLocalManagedReadiness({ configProvider: async (id) => source.providers[id] ?? null,
      codexStatus: async () => ({ enabled: true, available: true, reason: null }),
      openPondStatus: async () => ({ available: false, reason: "This qualification covers native agents only." }) }),
    approvalBlocked: async () => harness.state.approvals.some((approval) => approval.sessionId === sessionId && approval.status === "pending"),
    admit: (admission) => runner.admitUserLocalMessage(admission),
  });
  try {
    const first = runner.sendTurn(sessionId, { prompt: `Remember the exact token ${marker}. Reply with this token only.`, approvalPolicy: "never", sandbox: "read-only" });
    const firstTurn = await first;
    expect(firstTurn.status, firstTurn.error ?? "Initial controlled prompt").toBe("completed");
    const nativeId = harness.state.sessions.get(sessionId)!.nativeAgent?.sessionId ?? harness.state.sessions.get(sessionId)!.codexThreadId;
    expect(nativeId).toBeTruthy();

    const busy = runner.sendTurn(sessionId, { prompt: "Explain in four short paragraphs why a queue admission receipt cannot establish that an agent understood a message. Do not use tools.", approvalPolicy: "never", sandbox: "read-only" });
    await vi.waitFor(async () => expect((await runner.readTaskInbox(sessionId)).activeTurnId).toBeTruthy(), { timeout: 30_000, interval: 20 });
    const target = await messageService().inspect(sessionId);
    const queuedIntent = { authority: "user_click", mode: "followup", expectedTargetRevision: target.targetRevision,
      prompt: `Respond with ${followupMarker} followed by the exact remembered token from the initial turn. Do not use tools.`, idempotencyKey: "controlled-busy-queue" };
    const queued = await messageService().send(sessionId, queuedIntent);
    const retry = await messageService().send(sessionId, queuedIntent);
    expect(retry.id).toBe(queued.id);
    expect(queued).toMatchObject({ state: "pending", turnId: null });
    let steerReceipt = null;
    if (provider === "codex") {
      await vi.waitFor(() => expect(harness.state.turns.findLast((turn) => turn.status === "in_progress")?.providerTurnId).toBeTruthy(), { timeout: 30_000, interval: 20 });
      const turn = harness.state.turns.findLast((candidate) => candidate.status === "in_progress")!;
      const steerTarget = await messageService().inspect(sessionId);
      steerReceipt = await messageService().send(sessionId, { authority: "user_click", mode: "steer", expectedTargetRevision: steerTarget.targetRevision,
        expectedTurnId: turn.id, prompt: `Add ${steerMarker} to your response. Continue the original explanation.`, idempotencyKey: "controlled-active-steer" });
      await expect(runner.steerSessionTurn(sessionId, { expectedTurnId: "stale-owned-turn", prompt: "This stale correction must not be inserted.", idempotencyKey: "controlled-stale-steer" })).rejects.toThrow("no longer accepting");
    }
    expect(await busy).toMatchObject({ status: "completed" });
    await harness.dependencies.turnFollowUpQueue.drain();
    const queuedAfter = await harness.dependencies.store.getTaskInput(queued.id);
    expect(queuedAfter).toMatchObject({ state: "resolved" });
    expect(queuedAfter!.requestIds).toHaveLength(1);
    const response = (turnId: string | null) => harness.state.events.filter((event) => event.turnId === turnId && event.name === "assistant.delta").map((event) => event.output ?? "").join("");
    expect(response(queuedAfter!.turnId)).toContain(followupMarker);
    expect(response(queuedAfter!.turnId)).toContain(marker);
    if (steerReceipt) {
      expect(await harness.dependencies.store.getTaskInput(steerReceipt.id)).toMatchObject({ state: "resolved" });
      expect(response(steerReceipt.turnId)).toContain(steerMarker);
    }
    expect(harness.state.turns).toHaveLength(3);
    let approvalEvidence: { approvalId: string; interruptedTurnId: string; queuedInputId: string; pausedAcrossRestart: boolean } | null = null;
    let pausedIntent: { authority: string; mode: string; expectedTargetRevision: string; prompt: string; idempotencyKey: string } | null = null;
    if (provider === "claude-code") {
      const permissionTurn = runner.sendTurn(sessionId, { prompt: "Use AskUserQuestion to ask exactly one question: 'Continue controlled local messaging qualification?' Give options 'Continue' and 'Pause'. Wait for the answer before replying. This question is part of the qualification; do not invoke other tools." });
      await vi.waitFor(() => expect(harness.state.approvals.findLast((approval) => approval.status === "pending")).toBeTruthy(), { timeout: 45_000, interval: 50 });
      const approval = harness.state.approvals.findLast((candidate) => candidate.status === "pending")!;
      const blockedTarget = await messageService().inspect(sessionId);
      expect(blockedTarget).toMatchObject({ approvalBlocked: true, canSteer: false });
      pausedIntent = { authority: "user_click", mode: "followup", expectedTargetRevision: blockedTarget.targetRevision,
        prompt: "Reply with the exact remembered token from the initial turn only. Do not ask a question or use tools.", idempotencyKey: "controlled-paused-queue" };
      const pausedInput = await messageService().send(sessionId, pausedIntent);
      expect(pausedInput).toMatchObject({ state: "pending", turnId: null });
      expect(harness.state.approvals.find((candidate) => candidate.id === approval.id)?.status).toBe("pending");
      await runner.interruptSessionTurn(sessionId, "Controlled interruption of the qualification approval wait");
      const interrupted = await permissionTurn;
      expect(interrupted.status).toBe("interrupted");
      expect((await runner.readTaskInbox(sessionId)).paused).toBe(true);
      await harness.dependencies.turnFollowUpQueue.drain();
      expect(await harness.dependencies.store.getTaskInput(pausedInput.id)).toMatchObject({ state: "pending", turnId: null });
      approvalEvidence = { approvalId: approval.id, interruptedTurnId: interrupted.id, queuedInputId: pausedInput.id, pausedAcrossRestart: false };
    }
    await runner.close();
    for (const runtime of clients.values()) await runtime.client.stop();
    clients.clear();
    runner = createTurnRunner(harness.dependencies);
    await runner.recoverTaskInbox();
    expect((await messageService().send(sessionId, queuedIntent)).id).toBe(queued.id);
    await harness.dependencies.turnFollowUpQueue.drain();
    expect(harness.state.turns).toHaveLength(approvalEvidence ? 4 : 3);
    if (approvalEvidence && pausedIntent) {
      expect((await runner.readTaskInbox(sessionId)).paused).toBe(true);
      const stillPaused = await messageService().send(sessionId, pausedIntent);
      expect(stillPaused).toMatchObject({ id: approvalEvidence.queuedInputId, state: "pending", turnId: null });
      approvalEvidence.pausedAcrossRestart = true;
      // Explicit owner resumption, never caused by the recommendation or retry.
      await runner.updateTaskInput(sessionId, stillPaused.id, { action: "resume", expectedRevision: stillPaused.revision });
      await harness.dependencies.turnFollowUpQueue.drain();
      const resumedPaused = await harness.dependencies.store.getTaskInput(stillPaused.id);
      expect(resumedPaused).toMatchObject({ state: "resolved" });
      expect(response(resumedPaused!.turnId)).toContain(marker);
    }
    const resumed = await runner.queueTaskInput(sessionId, { prompt: "Reply with the exact remembered token from the initial turn only." }, "controlled-after-restart");
    await harness.dependencies.turnFollowUpQueue.drain();
    const resumedAfter = await harness.dependencies.store.getTaskInput(resumed.id);
    expect(resumedAfter).toMatchObject({ state: "resolved" });
    expect(response(resumedAfter!.turnId)).toContain(marker);
    expect(harness.state.sessions.get(sessionId)!.nativeAgent?.sessionId ?? harness.state.sessions.get(sessionId)!.codexThreadId).toBe(nativeId);
    const evidenceDir = resolve("docs/working-docs/agent-harness/evidence/2026-10-05-ponder-delivery/messaging");
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(join(evidenceDir, `${provider}-live.json`), JSON.stringify({ provider, version, checkedAt: new Date().toISOString(), sessionId, managedSessionId: nativeId,
      approvalEvidence, delivery: (await runner.readTaskInbox(sessionId)).inputs, turns: harness.state.turns.map((turn) => ({ id: turn.id, providerTurnId: turn.providerTurnId,
        status: turn.status, taskInputId: turn.metadata.taskInputId, response: response(turn.id) })), retryAfterRestartDuplicated: false }, null, 2) + "\n");
    // Keep the service import visible to typechecking without manufacturing a
    // second live receipt solely to exercise an already protected service seam.
    expect((await messageService().inspect(sessionId)).managedSessionId).toBe(nativeId);
  } finally {
    await runner.close();
    for (const runtime of clients.values()) await runtime.client.stop();
    await rm(directory, { recursive: true, force: true });
  }
}
