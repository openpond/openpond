import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

const LIVE_ENABLED = process.env.OPENPOND_APP_LIVE_SUBAGENT === "1";
const SERVER_URL = process.env.OPENPOND_APP_CURRENT_SERVER_URL || "http://127.0.0.1:17874";
const TOKEN_FILE =
  process.env.OPENPOND_APP_CURRENT_SERVER_TOKEN_FILE ||
  path.join(os.homedir(), ".openpond", "openpond-app", "token");
const PROVIDER_ID = process.env.OPENPOND_APP_LIVE_SUBAGENT_PROVIDER || "openai";
const MODEL_ID = process.env.OPENPOND_APP_LIVE_SUBAGENT_MODEL || "gpt-5.5";
const OUTPUT_DIR = process.env.OPENPOND_APP_LIVE_SUBAGENT_OUTPUT_DIR || "/tmp/openpond-subagent-smoke";

async function readToken() {
  if (process.env.OPENPOND_APP_CURRENT_SERVER_TOKEN) return process.env.OPENPOND_APP_CURRENT_SERVER_TOKEN;
  return (await readFile(TOKEN_FILE, "utf8")).trim();
}

async function api(token, route, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`${SERVER_URL}${route}`, { ...init, headers });
  const text = await response.text();
  if (!response.ok) throw new Error(`${route} failed: ${response.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

function openEventStream(token, events) {
  const controller = new AbortController();
  const ready = (async () => {
    const headers = new Headers();
    headers.set("Accept", "text/event-stream");
    headers.set("Authorization", `Bearer ${token}`);
    const response = await fetch(`${SERVER_URL}/v1/events`, {
      headers,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`event stream failed: ${response.status}`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("event stream did not return a body");
    const decoder = new TextDecoder();
    let buffer = "";
    while (!controller.signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const dataLine = raw.split("\n").find((line) => line.startsWith("data: "));
        if (dataLine) events.push(JSON.parse(dataLine.slice(6)));
        boundary = buffer.indexOf("\n\n");
      }
    }
  })();
  ready.catch((error) => {
    if (!controller.signal.aborted) events.push({ name: "event_stream_error", error: String(error) });
  });
  return controller;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForEvent(token, events, predicate, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let bootstrapEvents = [];
  while (Date.now() < deadline) {
    const event = [...events, ...bootstrapEvents].find(predicate);
    if (event) return event;
    const bootstrap = await api(token, "/v1/bootstrap?ensureProfile=0");
    bootstrapEvents = bootstrap.events ?? [];
    const storedEvent = bootstrapEvents.find(predicate);
    if (storedEvent) return storedEvent;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function bootstrapSessionState(token, parentSessionId, childSessionId) {
  const bootstrap = await api(token, "/v1/bootstrap?ensureProfile=0");
  const sessions = bootstrap.sessions ?? [];
  return {
    parentSession: sessions.find((session) => session.id === parentSessionId) ?? null,
    childSession: childSessionId
      ? sessions.find((session) => session.id === childSessionId) ?? null
      : null,
    events: bootstrap.events ?? [],
  };
}

function buildPrompt() {
  return [
    "Use a research subagent for the independent check in this request.",
    "Ask the child to inspect the current OpenPond subagent implementation and answer this narrow question: is subagent start triggered through a native model tool or by regex scanning the user prompt?",
    "After the child reports back, summarize the result in two concise bullets and include the child conversation id or run id if available.",
    "Do not edit files.",
  ].join("\n");
}

describe("live current OpenPond subagent orchestration", () => {
  test(
    "starts and joins a real child conversation through the current app server",
    { skip: !LIVE_ENABLED, timeout: 900000 },
    async () => {
      const token = await readToken();
      const healthResponse = await fetch(`${SERVER_URL}/health`);
      assert.equal(healthResponse.ok, true, "current app server must be running");

      const suffix = Date.now().toString(36).slice(-6);
      const title = `live-subagent-real-${suffix}`;
      const events = [];
      const stream = openEventStream(token, events);
      let outputPath = null;

      try {
        const session = await api(token, "/v1/sessions", {
          method: "POST",
          body: JSON.stringify({
            provider: PROVIDER_ID,
            modelRef: { providerId: PROVIDER_ID, modelId: MODEL_ID },
            title,
            cwd: process.cwd(),
          }),
        });
        const turnPromise = api(token, `/v1/sessions/${session.id}/turns`, {
          method: "POST",
          body: JSON.stringify({
            prompt: buildPrompt(),
            modelRef: { providerId: PROVIDER_ID, modelId: MODEL_ID },
            approvalPolicy: "never",
            sandbox: "read-only",
          }),
        });

        const startToolEvent = await waitForEvent(
          token,
          events,
          (event) => event.sessionId === session.id &&
            event.name === "tool.completed" &&
            event.action === "openpond_subagent_start" &&
            event.status === "completed",
          "openpond_subagent_start completion",
          240000,
        );
        const startedRun = startToolEvent.data?.result ?? {};
        assert.equal(startedRun.roleId, "research");
        assert.equal(startedRun.status, "queued");
        assert.ok(startedRun.runId, "start result should include runId");
        assert.ok(startedRun.childSessionId, "start result should include childSessionId");

        const completedEvent = await waitForEvent(
          token,
          events,
          (event) => event.sessionId === session.id &&
            event.name === "subagent.completed" &&
            event.data?.run?.id === startedRun.runId,
          "subagent.completed receipt",
          420000,
        );
        assert.equal(completedEvent.data?.run?.status, "completed");
        assert.equal(completedEvent.data?.run?.roleId, "research");
        assert.equal(completedEvent.data?.run?.childSessionId, startedRun.childSessionId);

        const parentDone = await waitForEvent(
          token,
          events,
          (event) => event.sessionId === session.id &&
            (event.name === "turn.completed" || event.name === "turn.failed"),
          "parent turn completion",
          240000,
        );
        await turnPromise;
        assert.equal(parentDone.name, "turn.completed", parentDone.output || "parent turn did not complete");

        const state = await bootstrapSessionState(token, session.id, startedRun.childSessionId);
        assert.equal(state.parentSession?.hiddenFromDefaultSidebar, false);
        assert.equal(state.childSession?.hiddenFromDefaultSidebar, true);
        assert.equal(state.childSession?.parentSessionId, session.id);
        assert.equal(state.childSession?.subagentRunId, startedRun.runId);
        assert.equal(state.childSession?.subagentRoleId, "research");
        assert.deepEqual(state.childSession?.modelRef, { providerId: PROVIDER_ID, modelId: MODEL_ID });

        const initialAssistantText = state.events
          .filter((event) => event.sessionId === session.id && event.name === "assistant.delta")
          .map((event) => event.output ?? "")
          .join("");
        let assistantText = initialAssistantText;
        let followUpTurnId = null;
        if (!/native model tool/i.test(assistantText) || !/not by regex|not regex|not.*regex/i.test(assistantText)) {
          const followUpTurn = await api(token, `/v1/sessions/${session.id}/turns`, {
            method: "POST",
            body: JSON.stringify({
              prompt: [
                "The research subagent has completed. Use the pushed subagent receipt and child conversation context already in this chat to answer the original narrow question now.",
                "Do not start another subagent unless the completed child result is unavailable.",
                "Answer in two concise bullets and include the child conversation id or run id if available.",
              ].join("\n"),
              modelRef: { providerId: PROVIDER_ID, modelId: MODEL_ID },
              approvalPolicy: "never",
              sandbox: "read-only",
            }),
          });
          followUpTurnId = followUpTurn?.id ?? null;
          if (followUpTurnId) {
            const followUpDone = await waitForEvent(
              token,
              events,
              (event) => event.sessionId === session.id &&
                event.turnId === followUpTurnId &&
                (event.name === "turn.completed" || event.name === "turn.failed"),
              "parent follow-up turn completion",
              240000,
            );
            assert.equal(followUpDone.name, "turn.completed", followUpDone.output || "parent follow-up did not complete");
          }
          const followUpState = await bootstrapSessionState(token, session.id, startedRun.childSessionId);
          assistantText = followUpState.events
            .filter((event) => event.sessionId === session.id && event.name === "assistant.delta")
            .map((event) => event.output ?? "")
            .join("");
        }
        assert.match(assistantText, /native model tool/i);
        assert.match(assistantText, /not by regex|not regex|not.*regex/i);

        await mkdir(OUTPUT_DIR, { recursive: true });
        outputPath = path.join(OUTPUT_DIR, `${title}.json`);
        await writeFile(
          outputPath,
          JSON.stringify(
            {
              server: SERVER_URL,
              providerId: PROVIDER_ID,
              modelId: MODEL_ID,
              parentSessionId: session.id,
              childSessionId: startedRun.childSessionId,
              runId: startedRun.runId,
              runStatus: completedEvent.data?.run?.status,
              parentTurnStatus: parentDone.name,
              followUpTurnId,
              initialAssistantText,
              assistantText,
            },
            null,
            2,
          ),
          "utf8",
        );

        console.log(
          JSON.stringify(
            {
              outputPath,
              parentSessionId: session.id,
              childSessionId: startedRun.childSessionId,
              runId: startedRun.runId,
              status: completedEvent.data?.run?.status,
            },
            null,
            2,
          ),
        );
      } finally {
        stream.abort();
      }
    },
  );
});
