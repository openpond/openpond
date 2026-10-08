import { mkdtemp, readFile, readlink, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { Session } from "@openpond/contracts";
import { createLocalTasksetWorkRuntime } from "../apps/server/src/training/local-taskset-work-runtime.js";

// Failure story: local Work commands used --share-net and inherited provider
// credentials. Exercise the public tool boundary so another runner cannot
// accidentally restore host networking while ordinary workspace work succeeds.
test("local Work executes offline without inheriting host credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "work-network-isolation-"));
  const hostNetwork = await readlink("/proc/self/ns/net");
  const server = createServer(socket => socket.destroy());
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const session = { id: "offline-work", cwd: root } as Session;
  const runtime = createLocalTasksetWorkRuntime({
    storeDir: root, deviceId: "test",
    createSession: async () => session, getSession: async () => session,
    runtimeEventsForSession: async () => [],
  });
  process.env.OPENPOND_WORK_TEST_SECRET = "host-credential";
  const code = `import os, socket, json
from pathlib import Path
checks = {"private_network": os.readlink("/proc/self/ns/net") != ${JSON.stringify(hostNetwork)}, "credentials_hidden": "OPENPOND_WORK_TEST_SECRET" not in os.environ}
try:
    socket.create_connection(("127.0.0.1", ${port}), timeout=0.2).close()
    checks["localhost_blocked"] = False
except OSError:
    checks["localhost_blocked"] = True
Path("/workspace/outputs/result.txt").write_text("offline work succeeds")
print(json.dumps(checks))`;
  try {
    const result = await runtime.executeWorkspaceTool(session.id, {
      action: "sandbox_exec", args: {
        command: `/usr/bin/python3 -I -S -c '${code.replaceAll("'", "'\\''")}'`,
        timeoutSeconds: 5,
      },
    });
    expect(result.ok, result.output).toBe(true);
    expect(JSON.parse(String((result.data as { stdout: string }).stdout))).toEqual({
      private_network: true, credentials_hidden: true, localhost_blocked: true,
    });
    expect(await readFile(join(root, "outputs/result.txt"), "utf8")).toBe("offline work succeeds");
  } finally {
    delete process.env.OPENPOND_WORK_TEST_SECRET;
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
