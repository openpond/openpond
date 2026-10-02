import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { listSessions } from "../src/native-conversations/history.js";

// Claude queue records precede the cwd owner. Guessing from the first row or
// another session can resume a conversation in the wrong working directory.
it("uses matching native Claude message metadata for cwd after queue bookkeeping", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-native-history-"));
  const sessionId = "a635de7e-1111-4222-8333-444444444444";
  const path = join(directory, `${sessionId}.jsonl`);
  const rows = [...Array.from({ length: 15 }, () => ({ type: "queue-operation", sessionId })), { type: "user", sessionId: "foreign", cwd: "/wrong" }, { type: "user", sessionId, cwd: directory, message: { content: "fixture" } }];
  await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  try {
    const source = { source: "claude_code" as const, root: directory, machineId: "machine", instanceId: "instance", acquisition: "files" as const, available: true, capabilities: { history: true, live: true, nativeResume: false } };
    const result = await listSessions(source);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ nativeSessionId: sessionId, cwd: directory });
    await writeFile(path, rows.slice(0, -1).map((row) => JSON.stringify(row)).join("\n") + "\n");
    expect((await listSessions(source)).items[0]?.cwd).toBeNull();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
