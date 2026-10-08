// Manual packaged integration check. Fixtures exercise HTTP contracts; this is
// not evidence of real model inference, Firecracker isolation, or TVC execution.
// Failure story: an unauthorized caller or wrong-owner sandbox must never cause
// external execution; a packaged real app-server must preserve that boundary.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({ options: { bundle: { type: "string" } }, allowPositionals: true });
if (positionals.length > 1 || (positionals.length && values.bundle)) throw new Error("Choose one executable or --bundle path.");
const executable = positionals[0] ? path.resolve(positionals[0]) : null;
const bundle = path.resolve(values.bundle ?? "dist/turnkey-agent/app.cjs");
const token = "fixture-caller-token";
const text = "Turnkey fixture ' $()\nUTF-8: café";
const digest = createHash("sha256").update(text).digest("hex");
let modelCalls = 0, executions = 0, wrongOwner = false, stallModel = false;
const fixture = createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
    const json = value => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
    if (request.url === "/v1/chat/completions") {
      assert.equal(request.headers.authorization, "Bearer fixture-model-key");
      modelCalls++;
      if (stallModel) return;
      const tool = body.messages.findLast(message => message.role === "tool");
      if (tool) json({ choices: [{ message: { content: tool.content.includes(digest) ? digest : "Tool unavailable." }, finish_reason: "stop" }] });
      else json({ choices: [{ message: { content: null, tool_calls: [{ id: "hash-call", type: "function",
        function: { name: "sandbox_sha256", arguments: JSON.stringify({ text }) } }] }, finish_reason: "tool_calls" }] });
      return;
    }
    assert.equal(request.headers["openpond-api-key"], "fixture-sandbox-key");
    const sandbox = { id: "fixture", teamId: wrongOwner ? "other-team" : "fixture-team" };
    if (request.url === "/v1/sandboxes/fixture") { json({ sandbox }); return; }
    assert.equal(request.url, "/v1/sandboxes/fixture/exec");
    assert.equal(body.command, `printf '%s' '${Buffer.from(text).toString("base64")}' | base64 -d | sha256sum`);
    assert.equal(body.timeoutSeconds, 15);
    executions++;
    json({ sandbox, command: { id: `fixture-command-${executions}`, status: "succeeded", exitCode: 0, output: `${digest}  -\n` } });
  } catch (error) {
    response.writeHead(500).end(JSON.stringify({ error: String(error) }));
  }
});
fixture.listen(0, "127.0.0.1");
await once(fixture, "listening");
const upstream = `http://127.0.0.1:${fixture.address().port}`;
const scratch = await mkdtemp(path.join(os.tmpdir(), "tvc-check-"));
const config = { host: "127.0.0.1", port: 0, authTokenSha256: createHash("sha256").update(token).digest("hex"),
  modelEndpoint: `${upstream}/v1`, model: "fixture-model", sandboxEndpoint: `${upstream}/v1/sandboxes`,
  sandboxId: "fixture", sandboxTeamId: "fixture-team", requestTimeoutMs: 30000 };
const child = spawn(executable ?? process.execPath, [
  ...(executable ? [] : [bundle]), "--config-json", JSON.stringify(config),
], { cwd: scratch, env: { PATH: process.env.PATH, TMPDIR: scratch }, stdio: ["ignore", "pipe", "pipe"] });
let stderr = "";
child.stderr.on("data", bytes => { stderr = (stderr + bytes).slice(-4000); });
try {
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Startup timed out: ${stderr}`)), 30_000);
    let stdout = "";
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`Startup exited ${code}: ${stderr}`)); });
    child.stdout.on("data", bytes => {
      stdout += bytes;
      for (const line of stdout.split("\n")) {
        try {
          const info = JSON.parse(line);
          if (info.status === "listening") { clearTimeout(timer); resolve(`http://127.0.0.1:${info.port}`); }
        } catch { /* wait for a complete structured startup line */ }
      }
    });
  });
  const credentials = { modelApiKey: "fixture-model-key", sandboxApiKey: "fixture-sandbox-key" };
  const chat = (auth = token, extra = {}) => fetch(`${endpoint}/chat`, {
    method: "POST", headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
    body: JSON.stringify({ prompt: `Compute SHA-256 of ${JSON.stringify(text)}`, credentials, ...extra }),
  });
  assert.equal((await fetch(`${endpoint}/health`)).status, 200);
  assert.equal((await chat("invalid")).status, 401);
  assert.equal((await chat(token, { sandboxId: "other-sandbox" })).status, 400);
  assert.equal(modelCalls, 0);
  assert.equal(executions, 0);

  const good = await chat();
  const result = await good.json();
  assert.equal(good.status, 200, JSON.stringify(result));
  assert.equal(result.answer, digest);
  assert.deepEqual(result.tools, [{ sandboxId: "fixture", commandId: "fixture-command-1", sha256: digest }]);
  assert.equal(modelCalls, 2);
  assert.equal(executions, 1);

  wrongOwner = true;
  const rejected = await chat();
  const rejectedResult = await rejected.json();
  assert.equal(rejected.status, 200, JSON.stringify(rejectedResult));
  assert.equal(rejectedResult.tools.length, 0);
  assert.equal(executions, 1, "wrong-owner sandbox was executed");
  wrongOwner = false;

  stallModel = true;
  const beforeTimeout = modelCalls;
  const timedOut = await chat();
  assert.equal(timedOut.status, 504);
  assert.equal((await timedOut.json()).retryable, false);
  assert.equal(modelCalls, beforeTimeout + 1, "timed-out model request was retried");
  assert.equal(executions, 1);
  // Deadline response can precede async shutdown; capacity must recover and
  // request SQLite homes must disappear before another successful request.
  stallModel = false;
  const recoveryDeadline = Date.now() + 5000;
  while ((await readdir(scratch)).some(name => name.startsWith("openpond-tvc-request-"))) {
    assert.ok(Date.now() < recoveryDeadline, "timed-out request leaked its runtime home");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const recovered = await chat();
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).answer, digest);
  assert.equal(executions, 2);
  assert.ok(!(await readdir(scratch)).some(name => name.startsWith("openpond-tvc-request-")), "completed request leaked its runtime home");
  console.log(JSON.stringify({ status: "passed", artifact: executable ? "executable" : "bundle",
    checks: ["real app-server startup", "auth before inference", "caller cannot change sandbox binding",
      "model-tool-model loop", "sandbox ownership before exec", "timeout without retry", "cleanup and capacity recovery"],
    modelCalls, sandboxExecutions: executions, realExternalServices: false }));
} finally {
  child.kill("SIGTERM");
  if (child.exitCode === null) {
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await once(child, "exit");
    clearTimeout(timer);
  }
  fixture.closeAllConnections();
  await new Promise(resolve => fixture.close(resolve));
  await rm(scratch, { recursive: true, force: true });
}
