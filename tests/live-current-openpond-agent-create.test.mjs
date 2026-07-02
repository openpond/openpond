import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

const LIVE_ENABLED = process.env.OPENPOND_APP_LIVE_CURRENT_AGENT === "1";
const SERVER_URL = process.env.OPENPOND_APP_CURRENT_SERVER_URL || "http://127.0.0.1:17874";
const TOKEN_FILE =
  process.env.OPENPOND_APP_CURRENT_SERVER_TOKEN_FILE ||
  path.join(os.homedir(), ".openpond", "openpond-app", "token");

async function readToken() {
  if (process.env.OPENPOND_APP_CURRENT_SERVER_TOKEN) return process.env.OPENPOND_APP_CURRENT_SERVER_TOKEN;
  return (await readFile(TOKEN_FILE, "utf8")).trim();
}

async function api(token, route, init) {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`${SERVER_URL}${route}`, { ...init, headers });
  if (!response.ok) throw new Error(`${route} failed: ${response.status} ${await response.text()}`);
  return response.json();
}

function openEventStream(token, sessionId, events) {
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
  throw new Error("timed out waiting for current-server agent creation");
}

function actionResults(events, sessionId) {
  return events.filter(
    (event) => event.sessionId === sessionId && event.name === "workspace_action_result"
  );
}

function hasCompletedAction(events, sessionId, action) {
  return actionResults(events, sessionId).some((event) => event.action === action && event.status === "completed");
}

function hasCompletedMutation(events, sessionId) {
  return actionResults(events, sessionId).some(
    (event) => ["update_template_config", "write_file", "write_files", "edit_file"].includes(event.action) && event.status === "completed"
  );
}

function buildNewAutomationPrompt({ name, description }) {
  return [
    `/agent ${name}`,
    `Create an OpenTool scheduled automation named "${name}".`,
    `Goal: ${description}`,
    "Schedule: Weekdays at 9:00 AM.",
    "Use the app workspace that was just scaffolded.",
    "Before editing files, call opentool_recipe_search for the requested capability and opentool_recipe_get for the best matching recipe.",
    "Use the recipe as guidance only.",
    "If the scaffold's existing config contract can express this scheduled prompt agent, call update_template_config with title, prompt, search, and schedule instead of editing source.",
    "Edit source only when the requested behavior is not represented by the config contract.",
    'For scheduled tools, define profile.schedule as an object with a cron field, for example { cron: "0 9 * * 1-5", enabled: false }, not as a bare string.',
    "Do not use emojis in responses, generated prompts, templates, profile text, comments, or sample output unless explicitly asked.",
    "Validate and build after edits, deploy preview, then call start_app with runOnceImmediately true so the schedule is promoted to production, started, and exercised once.",
    "Do not call deploy_production directly for managed automation creation.",
  ].join("\n");
}

describe("live current OpenPond agent creation", () => {
  test(
    "creates a real visible agent through the current app server",
    { skip: !LIVE_ENABLED, timeout: 900000 },
    async () => {
      const token = await readToken();
      const healthResponse = await fetch(`${SERVER_URL}/health`);
      assert.equal(healthResponse.ok, true, "current app server must be running");

      const suffix = Date.now().toString(36).slice(-6);
      const name = `live-ai-news-${suffix}`;
      const description = "search the web for ai news and return a concise digest";
      const events = [];

      const session = await api(token, "/v1/sessions", {
        method: "POST",
        body: JSON.stringify({ provider: "openpond", title: name }),
      });
      const stream = openEventStream(token, session.id, events);
      let appId = null;

      try {
        const scaffold = await api(token, `/v1/sessions/${session.id}/workspace-tools`, {
          method: "POST",
          body: JSON.stringify({
            action: "create_scaffold",
            args: {
              name,
              description,
              templateId: "opentool-base",
              mode: "auto",
            },
            source: "ui_button",
          }),
        });
        assert.equal(scaffold.ok, true, scaffold.output);
        appId = scaffold.appId || scaffold.data?.app?.id || null;
        assert.ok(appId, "create_scaffold should return an app id");

        const turnRequest = api(token, `/v1/sessions/${session.id}/turns`, {
          method: "POST",
          body: JSON.stringify({
            prompt: buildNewAutomationPrompt({ name, description }),
            model: process.env.OPENPOND_APP_LIVE_OPENPOND_MODEL || "openpond-chat",
            approvalPolicy: "never",
            sandbox: "workspace-write",
          }),
        });
        const done = await waitForTurn(events, 780000);
        await turnRequest;
        assert.equal(done.name, "turn.completed", done.error || "turn did not complete");
      } finally {
        stream.abort();
      }

      const bootstrap = await api(token, "/v1/bootstrap");
      const updatedSession = bootstrap.sessions.find((candidate) => candidate.id === session.id);
      const createdApp = bootstrap.apps.find((candidate) => candidate.id === appId);
      const allEvents = [
        ...events,
        ...bootstrap.events.filter((event) => event.sessionId === session.id),
      ];
      const completedActions = actionResults(allEvents, session.id)
        .filter((event) => event.status === "completed")
        .map((event) => event.action);

      console.log(
        JSON.stringify(
          {
            server: SERVER_URL,
            sessionId: session.id,
            appId,
            appName: createdApp?.name ?? null,
            workspace: updatedSession?.cwd ?? null,
            completedActions,
          },
          null,
          2
        )
      );

      assert.equal(updatedSession?.appId, appId, "session should stay bound to the created app");
      assert.equal(createdApp?.name, name, "created app should be present in current bootstrap payload");
      assert.equal(hasCompletedAction(allEvents, session.id, "create_scaffold"), true, "create_scaffold should complete");
      assert.equal(
        hasCompletedAction(allEvents, session.id, "opentool_recipe_search"),
        true,
        "builder should search OpenTool recipes before edits"
      );
      assert.equal(
        hasCompletedAction(allEvents, session.id, "opentool_recipe_get"),
        true,
        "builder should fetch a selected OpenTool recipe before edits"
      );
      assert.equal(hasCompletedMutation(allEvents, session.id), true, "builder should edit workspace source files");
      assert.equal(hasCompletedAction(allEvents, session.id, "validate_opentool"), true, "validate should complete");
      assert.equal(hasCompletedAction(allEvents, session.id, "build_opentool"), true, "build should complete");
      assert.equal(hasCompletedAction(allEvents, session.id, "deploy_preview"), true, "preview deploy should complete");
      assert.equal(hasCompletedAction(allEvents, session.id, "start_app"), true, "start_app should complete");
      const refreshed = await api(token, "/v1/openpond/apps/refresh", { method: "POST", body: "{}" });
      const refreshedApp = refreshed.apps.find((candidate) => candidate.id === appId);
      assert.ok(refreshedApp?.latestDeployment?.isProduction, "started app should have a production deployment");
      assert.ok(
        (refreshedApp?.scheduleSummary?.active ?? 0) > 0,
        "started automation should have at least one active schedule"
      );
    }
  );
});
