import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { createOpenPondServer } from "../apps/server/dist/index.js";

const LIVE_ENABLED = process.env.OPENPOND_APP_LIVE_OPENTOOL_DEPLOY === "1";

async function api(server, token, route, init) {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`${server}${route}`, { ...init, headers });
  if (!response.ok) throw new Error(`${route} failed: ${response.status} ${await response.text()}`);
  return response.json();
}

async function workspaceTool(instance, sessionId, action, args = {}) {
  return api(instance.url, instance.token, `/v1/sessions/${sessionId}/workspace-tools`, {
    method: "POST",
    body: JSON.stringify({ action, args, source: "terminal_command" }),
  });
}

function deploymentIdFrom(result, action) {
  const deploymentId = result?.data?.deployment?.deploymentId;
  assert.equal(result.ok, true, `${action} failed: ${result.output}`);
  assert.equal(typeof deploymentId, "string", `${action} should return a deployment id`);
  assert.ok(deploymentId.length > 0, `${action} should return a deployment id`);
  return deploymentId;
}

describe("live OpenTool deploy cycle", () => {
  test(
    "creates a hosted app, validates, builds, deploys preview, and deploys production",
    { skip: !LIVE_ENABLED, timeout: 900000 },
    async () => {
      const storeDir = await mkdtemp(path.join(os.tmpdir(), "openpond-live-opentool-deploy-"));
      const instance = await createOpenPondServer({ port: 0, storeDir, silent: true });
      try {
        const session = await api(instance.url, instance.token, "/v1/sessions", {
          method: "POST",
          body: JSON.stringify({ provider: "openpond", title: "live OpenTool deploy cycle" }),
        });

        const suffix = Date.now().toString(36);
        const scaffold = await workspaceTool(instance, session.id, "create_scaffold", {
          name: `live-opentool-deploy-${suffix}`,
          description: "Live OpenTool deployment cycle test app.",
          mode: "hosted",
        });
        assert.equal(scaffold.ok, true, scaffold.output);
        assert.equal(scaffold.data.mode, "hosted");
        assert.ok(scaffold.appId);

        const validate = await workspaceTool(instance, session.id, "validate_opentool");
        assert.equal(validate.ok, true, validate.output);

        const build = await workspaceTool(instance, session.id, "build_opentool");
        assert.equal(build.ok, true, build.output);

        const preview = await workspaceTool(instance, session.id, "deploy_preview");
        const previewDeploymentId = deploymentIdFrom(preview, "deploy_preview");
        assert.equal(preview.data.deployment.environment, "preview");

        const previewStatus = await workspaceTool(instance, session.id, "deployment_status", {
          deploymentId: previewDeploymentId,
        });
        assert.equal(previewStatus.ok, true, previewStatus.output);

        const production = await workspaceTool(instance, session.id, "deploy_production");
        const productionDeploymentId = deploymentIdFrom(production, "deploy_production");
        assert.equal(production.data.deployment.environment, "production");

        const productionStatus = await workspaceTool(instance, session.id, "deployment_status", {
          deploymentId: productionDeploymentId,
        });
        assert.equal(productionStatus.ok, true, productionStatus.output);
      } finally {
        await instance.close();
        await rm(storeDir, { recursive: true, force: true });
      }
    }
  );
});
