import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runWorkspaceCommand } from "../apps/server/src/workspace/workspace-command";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("runWorkspaceCommand", () => {
  test("passes stdin to workspace commands", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "openpond-workspace-command-"));
    tempRoots.push(root);
    const init = await runWorkspaceCommand("git", ["init"], root);
    expect(init.code).toBe(0);

    const patch = [
      "diff --git a/example.txt b/example.txt",
      "new file mode 100644",
      "index 0000000..ce01362",
      "--- /dev/null",
      "+++ b/example.txt",
      "@@ -0,0 +1 @@",
      "+hello",
      "",
    ].join("\n");
    const check = await runWorkspaceCommand("git", ["apply", "--check", "-"], root, {}, patch);
    expect(check.code).toBe(0);

    const apply = await runWorkspaceCommand("git", ["apply", "-"], root, {}, patch);
    expect(apply.code).toBe(0);
    await expect(readFile(path.join(root, "example.txt"), "utf8")).resolves.toBe("hello\n");
  });
});
