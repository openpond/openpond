import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { createOpenPondServer } from "../apps/server/dist/index.js";

const LIVE_ENABLED = process.env.OPENPOND_APP_LIVE_OPENPOND === "1";
const LIVE_RECIPE_BUILDER_ENABLED = process.env.OPENPOND_APP_LIVE_RECIPE_BUILDER === "1";
const LIVE_WEB_SEARCH_ENABLED =
  process.env.OPENPOND_APP_LIVE_OPENPOND_WEB_SEARCH === "1" ||
  process.env.OPENPOND_APP_LIVE_WEB_SEARCH === "1";

async function api(server, token, route, init) {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`${server}${route}`, { ...init, headers });
  if (!response.ok) throw new Error(`${route} failed: ${response.status} ${await response.text()}`);
  return response.json();
}

function openEventStream(server, token, sessionId, events) {
  const controller = new AbortController();
  const ready = (async () => {
    const headers = new Headers();
    headers.set("Accept", "text/event-stream");
    headers.set("Authorization", `Bearer ${token}`);
    const response = await fetch(`${server}/v1/events`, {
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
        if (dataLine) {
          const event = JSON.parse(dataLine.slice(6));
          if (!event.sessionId || event.sessionId === sessionId) events.push(event);
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  })();
  ready.catch((error) => {
    if (!controller.signal.aborted) events.push({ name: "diagnostic", error: String(error) });
  });
  return controller;
}

async function waitForTurn(events, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const done = events.find((event) => event.name === "turn.completed" || event.name === "turn.failed");
    if (done) return done;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("timed out waiting for live turn completion");
}

function assistantOutput(events, sessionId) {
  return events
    .filter((event) => event.sessionId === sessionId && event.name === "assistant.delta")
    .map((event) => event.output || "")
    .join("");
}

describe("live OpenPond scaffold loop", () => {
  test(
    "searches the web for AI news through the actual hosted OpenPond system",
    { skip: !LIVE_WEB_SEARCH_ENABLED, timeout: 240000 },
    async () => {
      const storeDir = await mkdtemp(path.join(os.tmpdir(), "openpond-live-web-search-"));
      const instance = await createOpenPondServer({ port: 0, storeDir, silent: true });
      const events = [];
      try {
        const session = await api(instance.url, instance.token, "/v1/sessions", {
          method: "POST",
          body: JSON.stringify({ provider: "openpond", title: "live web search" }),
        });
        const stream = openEventStream(instance.url, instance.token, session.id, events);
        try {
          const turnRequest = api(instance.url, instance.token, `/v1/sessions/${session.id}/turns`, {
            method: "POST",
            body: JSON.stringify({
              prompt: "search the web for ai news. Do not use emojis.",
              model: process.env.OPENPOND_APP_LIVE_OPENPOND_MODEL || "openpond-chat",
              approvalPolicy: "never",
              sandbox: "workspace-write",
            }),
          });
          const done = await waitForTurn(events, 180000);
          await turnRequest;
          assert.equal(done.name, "turn.completed", done.error || "turn did not complete");
        } finally {
          stream.abort();
        }

        const output = assistantOutput(events, session.id);
        assert.match(output, /ai|artificial intelligence/i, "assistant response should discuss AI");
        assert.match(output, /news|latest|recent|today|source|reported/i, "assistant response should look like a news result");
        assert.ok(output.trim().length > 120, "assistant should return a substantive web-search answer");

        const bootstrap = await api(instance.url, instance.token, "/v1/bootstrap");
        const updatedSession = bootstrap.sessions.find((candidate) => candidate.id === session.id);
        assert.equal(updatedSession?.appId ?? null, null, "web-search prompt should not scaffold an app");
        assert.equal(
          bootstrap.events.some(
            (event) =>
              event.sessionId === session.id &&
              event.name === "workspace_action_result" &&
              event.action === "create_scaffold"
          ),
          false,
          "web-search prompt should not call create_scaffold"
        );
      } finally {
        await instance.close();
        await rm(storeDir, { recursive: true, force: true });
      }
    }
  );

  test(
    "sends a real message and waits for scaffold loop events",
    { skip: !LIVE_ENABLED },
    async () => {
      const storeDir = await mkdtemp(path.join(os.tmpdir(), "openpond-live-scaffold-test-"));
      const instance = await createOpenPondServer({ port: 0, storeDir, silent: true });
      const events = [];
      try {
        const session = await api(instance.url, instance.token, "/v1/sessions", {
          method: "POST",
          body: JSON.stringify({ provider: "openpond", title: "live scaffold loop" }),
        });
        const stream = openEventStream(instance.url, instance.token, session.id, events);
        try {
          const turnRequest = api(instance.url, instance.token, `/v1/sessions/${session.id}/turns`, {
            method: "POST",
            body: JSON.stringify({
              prompt: "Create an OpenTool agent that echoes a message. Do not use emojis.",
              model: process.env.OPENPOND_APP_LIVE_OPENPOND_MODEL || "openpond-chat",
              approvalPolicy: "never",
              sandbox: "workspace-write",
            }),
          });
          const done = await waitForTurn(events, 180000);
          await turnRequest;
          assert.equal(done.name, "turn.completed", done.error || "turn did not complete");
        } finally {
          stream.abort();
        }

        const bootstrap = await api(instance.url, instance.token, "/v1/bootstrap");
        const updatedSession = bootstrap.sessions.find((candidate) => candidate.id === session.id);
        assert.ok(updatedSession?.appId, "session should be bound to a scaffolded app");
        assert.ok(updatedSession?.cwd, "session should be bound to a workspace path");
        assert.ok(
          bootstrap.events.some(
            (event) =>
              event.sessionId === session.id &&
              event.name === "workspace_action_result" &&
              event.action === "create_scaffold" &&
              event.status === "completed"
          ),
          "create_scaffold should emit a completed workspace action"
        );
      } finally {
        await instance.close();
        await rm(storeDir, { recursive: true, force: true });
      }
    }
  );

  test(
    "runs the live recipe-guided agent builder through preview deploy",
    { skip: !LIVE_RECIPE_BUILDER_ENABLED, timeout: 900000 },
    async () => {
      const storeDir = await mkdtemp(path.join(os.tmpdir(), "openpond-live-recipe-builder-"));
      const instance = await createOpenPondServer({ port: 0, storeDir, silent: true });
      const events = [];
      try {
        const session = await api(instance.url, instance.token, "/v1/sessions", {
          method: "POST",
          body: JSON.stringify({ provider: "openpond", title: "live recipe builder" }),
        });
        const suffix = Date.now().toString(36);
        const stream = openEventStream(instance.url, instance.token, session.id, events);
        try {
          const turnRequest = api(instance.url, instance.token, `/v1/sessions/${session.id}/turns`, {
            method: "POST",
            body: JSON.stringify({
              prompt: [
                `/agent live recipe builder ${suffix}`,
                "Create a minimal OpenTool scheduled automation that returns a JSON markdown digest.",
                "Before editing files, call opentool_recipe_search and opentool_recipe_get.",
                "Do not use emojis in responses, generated prompts, templates, profile text, comments, or sample output unless explicitly asked.",
                "Do not set runChecks false.",
                "After edits, validate, build, and deploy preview. Do not start or promote production.",
              ].join("\n"),
              model: process.env.OPENPOND_APP_LIVE_OPENPOND_MODEL || "openpond-chat",
              approvalPolicy: "never",
              sandbox: "workspace-write",
            }),
          });
          const done = await waitForTurn(events, 600000);
          await turnRequest;
          assert.equal(done.name, "turn.completed", done.error || "turn did not complete");
        } finally {
          stream.abort();
        }

        const bootstrap = await api(instance.url, instance.token, "/v1/bootstrap");
        const updatedSession = bootstrap.sessions.find((candidate) => candidate.id === session.id);
        assert.ok(updatedSession?.appId, "session should be bound to a scaffolded app");
        assert.ok(updatedSession?.cwd, "session should be bound to a workspace path");

        for (const action of [
          "create_scaffold",
          "opentool_recipe_search",
          "opentool_recipe_get",
          "validate_opentool",
          "build_opentool",
          "deploy_preview",
        ]) {
          assert.ok(
            bootstrap.events.some(
              (event) =>
                event.sessionId === session.id &&
                event.name === "workspace_action_result" &&
                event.action === action &&
                event.status === "completed"
            ),
            `${action} should complete`
          );
        }

        assert.ok(
          bootstrap.events.some(
            (event) =>
              event.sessionId === session.id &&
              event.name === "workspace_action_result" &&
              ["write_file", "write_files", "edit_file"].includes(event.action) &&
              event.status === "completed"
          ),
          "a workspace mutation should complete"
        );
      } finally {
        await instance.close();
        await rm(storeDir, { recursive: true, force: true });
      }
    }
  );
});
