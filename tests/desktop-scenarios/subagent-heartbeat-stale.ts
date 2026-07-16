import { DatabaseSync } from "node:sqlite";
import type { BootstrapPayload, RuntimeEvent, Session } from "@openpond/contracts";
import { normalizeSqliteParameters } from "../../apps/server/src/store/sqlite/sqlite-values";

import { desktopScenario } from "../../scripts/desktop-harness/scenario";
import type { DesktopHarness } from "../../scripts/desktop-harness/types";
import {
  asRecord,
  configureResearchSubagentModel,
  registerScriptedOpenPondModel,
  reloadRenderer,
  stringFromRecord,
  toolResultFromEvent,
  waitForAssistantOutput,
  waitForCompletedTurn,
} from "./helpers";

const modelRef = {
  providerId: "openpond" as const,
  modelId: "openpond-scripted-subagent-stale",
};

const STALE_AGE_MS = 60 * 60 * 1000;

export default desktopScenario({
  name: "subagent-heartbeat-stale",
  mode: "isolated",
  timeoutMs: 150_000,
  async run(harness) {
    await registerScriptedOpenPondModel(harness, modelRef);
    await configureResearchSubagentModel(harness, modelRef, { heartbeatIntervalSeconds: 10 });

    const required = await createStaleProofSession(harness, {
      titlePrefix: "subagent-heartbeat-stale-required",
      prompt: "Start a required stale watcher child and keep it running for policy proof.",
    });
    const optional = await createStaleProofSession(harness, {
      titlePrefix: "subagent-heartbeat-stale-optional",
      prompt: "Start an optional stale watcher child and keep it running for policy proof.",
    });

    const agedAt = await ageSubagentRuns(harness, [required.runId, optional.runId], STALE_AGE_MS);
    harness.recordMetadata({
      agedAt,
      staleAgeMs: STALE_AGE_MS,
      requiredParentSessionId: required.session.id,
      optionalParentSessionId: optional.session.id,
      requiredRunId: required.runId,
      optionalRunId: optional.runId,
    });

    const requiredStale = await waitForStaleReceipt(harness, {
      sessionId: required.session.id,
      runId: required.runId,
      policy: "required_blocker",
    });
    const optionalStale = await waitForStaleReceipt(harness, {
      sessionId: optional.session.id,
      runId: optional.runId,
      policy: "optional_attention",
    });
    harness.recordAssertion("requiredStaleReceiptVisible", true);
    harness.recordAssertion("optionalStaleReceiptVisible", true);

    const requiredWake = await waitForRequiredStaleWake(harness, required.session.id, required.runId);
    const requiredAssistantWake = await waitForAssistantOutput(
      harness,
      required.session.id,
      `Watcher lifecycle review wake received for ${required.runId}.`,
      "required stale lifecycle wake assistant response",
    );
    await waitForCompletedTurn(harness, required.session.id, requiredAssistantWake, "required stale lifecycle wake completion");
    harness.recordAssertion("requiredStaleQueuedParentWake", true);

    const bootstrapAfterStale = await harness.api.bootstrap<BootstrapPayload>();
    const optionalWakeEvents = bootstrapAfterStale.events.filter((event) =>
      event.sessionId === optional.session.id &&
      event.name === "diagnostic" &&
      asRecord(event.data)?.kind === "subagent_lifecycle_watcher_wake"
    );
    const optionalWakeResponses = bootstrapAfterStale.events.filter((event) =>
      event.sessionId === optional.session.id &&
      event.name === "assistant.delta" &&
      typeof event.output === "string" &&
      event.output.includes(`Watcher lifecycle review wake received for ${optional.runId}.`)
    );
    if (optionalWakeEvents.length > 0) {
      throw new Error(`Expected optional stale run not to queue a parent wake, found ${optionalWakeEvents.length}.`);
    }
    if (optionalWakeResponses.length > 0) {
      throw new Error(`Expected optional stale run not to wake the parent model, found ${optionalWakeResponses.length}.`);
    }
    harness.recordAssertion("optionalStaleDidNotWakeParent", true);

    await harness.renderer.selectSession(required.session.id, { timeoutMs: 10_000 });
    await harness.renderer.assertText("Subagent stale", {
      label: "required stale activity summary",
      timeoutMs: 10_000,
    });
    await harness.renderer.assertText(`Watcher lifecycle review wake received for ${required.runId}.`, {
      label: "required stale parent wake visible",
    });
    harness.recordAssertion("requiredStaleActivityVisible", true);
    await harness.screenshot("subagent-heartbeat-stale-required");

    await harness.renderer.selectSession(optional.session.id, { timeoutMs: 10_000 });
    await harness.renderer.assertText("Subagent stale", {
      label: "optional stale activity summary",
      timeoutMs: 10_000,
    });
    harness.recordAssertion("optionalStaleActivityVisible", true);
    await harness.screenshot("subagent-heartbeat-stale-optional");

    await Promise.all([
      harness.events.waitForSubagentSubmitted(required.session.id, required.runId, { timeoutMs: 80_000 }),
      harness.events.waitForSubagentSubmitted(optional.session.id, optional.runId, { timeoutMs: 80_000 }),
    ]);
    harness.recordAssertion("staleChildrenEventuallySubmitted", true);

    const bootstrap = await harness.api.bootstrap<BootstrapPayload>();
    harness.recordMetadata({
      requiredChildSessionId: required.childSessionId,
      optionalChildSessionId: optional.childSessionId,
      requiredStaleEventId: requiredStale.id ?? null,
      optionalStaleEventId: optionalStale.id ?? null,
      requiredWakeDiagnosticId: requiredWake.id ?? null,
      requiredLifecycleWakeTurnId: requiredAssistantWake.turnId ?? null,
      requiredRuntimeEventCount: bootstrap.events.filter((event) => event.sessionId === required.session.id).length,
      optionalRuntimeEventCount: bootstrap.events.filter((event) => event.sessionId === optional.session.id).length,
    });
  },
});

async function createStaleProofSession(
  harness: DesktopHarness,
  input: {
    titlePrefix: string;
    prompt: string;
  },
): Promise<{
  session: Session;
  runId: string;
  childSessionId: string;
  startEvent: RuntimeEvent;
}> {
  const title = harness.uniqueTitle(input.titlePrefix);
  const session = await harness.api.createSession<Session>({
    provider: "openpond",
    modelRef,
    title,
    cwd: harness.repoRoot,
  });

  await reloadRenderer(harness);
  await harness.renderer.selectSession(session.id);
  await harness.renderer.assertText(title, { label: `${input.titlePrefix} parent session title` });
  await harness.api.createTurn(session.id, {
    prompt: input.prompt,
    modelRef,
  });

  const startEvent = await harness.events.waitForToolCompleted(
    session.id,
    "openpond_subagent_start",
  ) as RuntimeEvent;
  const startResult = toolResultFromEvent(startEvent);
  const runId = stringFromRecord(startResult, "runId");
  const childSessionId = stringFromRecord(startResult, "childSessionId");
  if (!runId) throw new Error("openpond_subagent_start did not return a runId.");
  if (!childSessionId) throw new Error("openpond_subagent_start did not return a childSessionId.");
  await waitForCompletedTurn(harness, session.id, startEvent, `${input.titlePrefix} parent start turn completion`);
  await harness.events.waitFor(
    (event) =>
      event.sessionId === session.id &&
      event.name === "subagent.started" &&
      stringFromRecord(asRecord(asRecord(event.data)?.run), "id") === runId,
    `subagent.started:${runId}`,
    { sessionId: session.id },
  );
  return { session, runId, childSessionId, startEvent };
}

async function waitForStaleReceipt(
  harness: DesktopHarness,
  input: {
    sessionId: string;
    runId: string;
    policy: "required_blocker" | "optional_attention";
  },
): Promise<RuntimeEvent> {
  return await harness.events.waitFor(
    (event) => {
      if (event.sessionId !== input.sessionId || event.name !== "subagent.stale") return false;
      const data = asRecord(event.data);
      const stale = asRecord(data?.stale);
      const run = asRecord(data?.run);
      return stringFromRecord(run, "id") === input.runId &&
        stringFromRecord(stale, "policy") === input.policy &&
        stale?.attentionNeeded === true;
    },
    `subagent.stale:${input.runId}:${input.policy}`,
    { sessionId: input.sessionId, timeoutMs: 35_000 },
  ) as RuntimeEvent;
}

async function waitForRequiredStaleWake(
  harness: DesktopHarness,
  sessionId: string,
  runId: string,
): Promise<RuntimeEvent> {
  return await harness.events.waitFor(
    (event) => {
      if (event.sessionId !== sessionId || event.name !== "diagnostic") return false;
      const data = asRecord(event.data);
      const runIds = Array.isArray(data?.runIds) ? data.runIds : [];
      const reasons = Array.isArray(data?.reasons) ? data.reasons : [];
      return data?.kind === "subagent_lifecycle_watcher_wake" &&
        data.wakeQueued === true &&
        stringFromRecord(data, "wakeQueuedParentSessionId") === sessionId &&
        runIds.includes(runId) &&
        reasons.includes("required_stale");
    },
    `required stale watcher wake:${runId}`,
    { sessionId, timeoutMs: 35_000 },
  ) as RuntimeEvent;
}

async function ageSubagentRuns(
  harness: DesktopHarness,
  runIds: string[],
  ageMs: number,
): Promise<string> {
  const bootstrap = await harness.api.bootstrap<BootstrapPayload>();
  const agedAt = new Date(Date.now() - ageMs).toISOString();
  const db = new DatabaseSync(bootstrap.server.storePath, { timeout: 1_000 });
  try {
    for (const runId of runIds) {
      runSql(db, "UPDATE subagent_runs SET updated_at = ? WHERE id = ?", [agedAt, runId]);
    }
  } finally {
    db.close();
  }
  return agedAt;
}

function runSql(db: DatabaseSync, sql: string, params: unknown[]): void {
  const result = db.prepare(sql).run(...normalizeSqliteParameters(params));
  if (result.changes === 0) throw new Error(`No rows updated for SQL: ${sql}`);
}
