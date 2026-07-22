#!/usr/bin/env node

import { createServer } from "node:http";

const host = "127.0.0.1";
const port = Number.parseInt(process.env.OPENPOND_TUTORIAL_HOSTED_PROFILE_PORT ?? "41739", 10);
const teamId = "team-account-health-tutorial";

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);
  if (request.method === "POST" && url.pathname === "/v1/profile/ensure") {
    sendJson(response, {
      profile: {
        id: "profile-account-health-tutorial",
        project: { id: "project-account-health-profile" },
        sourceUpload: null,
        teamId,
      },
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/profile/push") {
    const body = await readJson(request);
    const sourceCommitSha = typeof body.localHeadSha === "string"
      ? body.localHeadSha
      : "tutorial-hosted-profile-commit";
    sendJson(response, {
      profile: {
        id: "profile-account-health-tutorial",
        project: { id: "project-account-health-profile" },
        teamId,
      },
      sourceUpload: {
        sourceCommitSha,
        sourceRef: typeof body.branch === "string" ? body.branch : "main",
      },
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/organizations") {
    sendJson(response, {
      organizations: [{
        teamId,
        slug: "account-health-tutorial",
        name: "Account Health Tutorial Team",
        displayName: "Account Health Tutorial Team",
        role: "owner",
        status: "active",
        isDefault: true,
      }],
    });
    return;
  }
  sendJson(response, {
    agents: [],
    connections: [],
    organizations: [],
    projects: [],
    sandboxes: [],
  });
});

server.listen(port, host, () => {
  process.stdout.write(`http://${host}:${port}/v1/sandboxes\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response, value) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}
