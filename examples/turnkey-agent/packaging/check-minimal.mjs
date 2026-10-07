import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// Failure story: pkg booted locally with Docker's HOME but crashed before our
// entrypoint in QOS, which has no HOME or passwd database. The scratch image
// plus an env-empty child reproduces that boundary without compiling a runtime.
const image = process.argv[2];
assert(image, "Pass the built scratch transport image tag");
const config = {
  host: "0.0.0.0", port: 3000, authTokenSha256: "0".repeat(64),
  modelEndpoint: "https://example.invalid/v1", model: "startup-only",
  sandboxEndpoint: "https://example.invalid/sandboxes",
  sandboxId: "startup-only", sandboxTeamId: "startup-only",
};
const script = `const r=require('node:child_process').spawnSync(process.execPath,
  ['--probe','--config-json',${JSON.stringify(JSON.stringify(config))}],
  {env:{},stdio:'inherit'});process.exit(r.status??1);`;
const result = spawnSync("docker", [
  "run", "--rm", "--network", "none", "--memory", "1g", "--read-only",
  "--user", "65532:65532", "--env", "PKG_EXECPATH=PKG_INVOKE_NODEJS",
  "--tmpfs", "/tmp:rw,nosuid,nodev,mode=1777,size=256m", image, "-e", script,
], { encoding: "utf8", timeout: 60_000 });
assert.equal(result.status, 0, result.stderr || result.error?.message);
assert.deepEqual(JSON.parse(result.stdout.trim()), { status: "ok", appServer: true, sqlite: true });
console.log("Minimal environment startup passed: empty environment, no passwd, no network, read-only root, 1 GiB memory.");
