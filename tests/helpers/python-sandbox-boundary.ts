import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersistentPythonSandbox } from "../../apps/server/src/training/cross-system-operations/python-sandbox.js";

/** Shared real-process proof used locally and with the exact bundled executor
 * in a staging guest. Secrets/files are synthetic; no external service is hit. */
export async function provePythonSandboxBoundary(): Promise<Record<string, boolean>> {
  const sandboxes: PersistentPythonSandbox[] = [];
  const previousSecret = process.env.OPENPOND_SANDBOX_TEST_SECRET;
  const trackSandbox = () => {
    const sandbox = new PersistentPythonSandbox();
    sandboxes.push(sandbox);
    return sandbox;
  };
  const directory = await mkdtemp(join(tmpdir(), "python-isolation-"));
  const secret = join(directory, "private-answer.txt");
  const hostNetwork = await readlink("/proc/self/ns/net");
  await writeFile(secret, "private-reference");
  let connections = 0;
  const server = createServer(socket => { connections++; socket.destroy(); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  process.env.OPENPOND_SANDBOX_TEST_SECRET = "host-credential";
  try {
    const sandbox = trackSandbox();
    assert.equal((await sandbox.run("counter = 4\n_result = counter")).result, 4);
    assert.equal((await sandbox.run("counter += 1\n_result = counter")).result, 5);
    const result = await sandbox.run(`
raw_import = __import__.__globals__["real_import"]
os = raw_import("os")
socket = raw_import("socket")
pathlib = raw_import("pathlib")
checks = {"credentials_hidden": "OPENPOND_SANDBOX_TEST_SECRET" not in os.environ}
checks["private_network"] = os.readlink("/proc/self/ns/net") != ${JSON.stringify(hostNetwork)}
for name, host, port in [("localhost_blocked", "127.0.0.1", ${port}), ("internet_blocked", "192.0.2.1", 80), ("metadata_blocked", "169.254.169.254", 80)]:
  try:
      connection = socket.create_connection((host, port), timeout=0.1)
      connection.close()
      checks[name] = False
  except Exception:
      checks[name] = True
try:
  pathlib.Path(${JSON.stringify(secret)}).read_text()
  checks["host_files_hidden"] = False
except Exception:
  checks["host_files_hidden"] = True
try:
  pathlib.Path(${JSON.stringify(secret)}).write_text("tampered")
  checks["host_writes_blocked"] = False
except Exception:
  checks["host_writes_blocked"] = True
pathlib.Path("/tmp/attempt-state").write_text("private")
checks["namespace_init"] = os.getpid() == 1
_result = checks
`);
    assert.equal(result.ok, true, result.error ?? "Python execution failed");
    assert.deepEqual(result.result, {
      credentials_hidden: true, private_network: true, localhost_blocked: true, internet_blocked: true,
      metadata_blocked: true, host_files_hidden: true, host_writes_blocked: true, namespace_init: true,
    });
    assert.equal(connections, 0);
    assert.equal(await readFile(secret, "utf8"), "private-reference");
    await sandbox.close();
    const fresh = await trackSandbox().run(`raw_import = __import__.__globals__["real_import"]\n_result = raw_import("pathlib").Path("/tmp/attempt-state").exists()`);
    assert.equal(fresh.ok, true, fresh.error ?? "Fresh worker failed");
    assert.equal(fresh.result, false);
    return { ...result.result as Record<string, boolean>, state_persists: true, attempts_isolated: true };

  } finally {
    await Promise.all(sandboxes.map(sandbox => sandbox.close()));
    if (previousSecret === undefined) delete process.env.OPENPOND_SANDBOX_TEST_SECRET;
    else process.env.OPENPOND_SANDBOX_TEST_SECRET = previousSecret;
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}
