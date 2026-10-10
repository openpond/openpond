import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { SessionSchema, type PonderDesktopOperation } from "@openpond/contracts";
import { SqliteStore } from "../store/store.js";
import { runWorkspaceCommand } from "../workspace/workspace-command.js";
import { createPonderDesktopSourceStore } from "./ponder-desktop-source.js";
import { assertDesktopWorkflowSource } from "./ponder-desktop-workflow-context.js";

// A reviewer must read the retained result's bytes after a restart, even if the
// checkout moved. A different result/workspace, symlink escape or corrupted blob
// must never substitute source evidence.
it("retains changed source and exact Git context across checkout changes and store restart", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ponder-review-source-"));
  const cwd = path.join(directory, "repo"),
    home = path.join(directory, "home");
  let store = new SqliteStore(home);
  try {
    await mkdir(cwd);
    const git = async (...args: string[]) => {
      const result = await runWorkspaceCommand("git", args, cwd);
      expect(result.code, result.stderr).toBe(0);
    };
    await git("init");
    await writeFile(path.join(cwd, "table.ts"), "export const preview = 'short';\n");
    await writeFile(path.join(cwd, "removed.ts"), "export const old = true;\n");
    await writeFile(path.join(cwd, "unchanged.ts"), "export const context = 'original';\n");
    await git("add", ".");
    await git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "Fixture baseline",
    );
    await writeFile(path.join(cwd, "table.ts"), "export const preview = 'expandable';\n");
    await writeFile(path.join(cwd, "new.ts"), "export const keyboard = true;\n");
    await writeFile(
      path.join(cwd, ".env.fixture"),
      "Private fixture excluded from source evidence",
    );
    await rm(path.join(cwd, "removed.ts"));
    const owner = {
      version: 1 as const,
      installationId: randomUUID(),
      profileId: "fixture",
      ownerUserId: "owner",
      teamId: "team",
      audience: "https://fixture.invalid",
    };
    const session = SessionSchema.parse({
      id: "implementer",
      provider: "claude-code",
      experience: "work",
      title: "Implement",
      appId: null,
      appName: null,
      cwd,
      localProjectId: "project",
      codexThreadId: null,
      createdAt: "fixture",
      updatedAt: "fixture",
      status: "idle",
      pinned: false,
      archived: false,
      order: 0,
      metadata: { ponderLocalOwner: owner },
    });
    const sourceStore = createPonderDesktopSourceStore(home);
    const source = await sourceStore.capture(session, "exact-turn");
    const index = await sourceStore.inspect(source, undefined);
    expect(index.files?.map((file) => file.path)).toEqual(["new.ts", "table.ts"]);
    expect(index.changedFiles).toEqual(["new.ts", "removed.ts", "table.ts"]);
    await store.commitPonderDesktopResult({
      operationId: "prerequisite",
      payloadHash: "a".repeat(64),
      sessionId: session.id,
      sessionTitle: session.title,
      inputId: "assignment",
      turnId: source.turnId,
      completedAt: new Date().toISOString(),
      outcome: "completed",
      body: "Validated",
      bodyTruncated: false,
      assistantEventIds: [],
      providerId: session.provider,
      modelId: null,
      workspaceId: source.workspaceId,
      outputs: [],
      error: null,
      source,
    });
    store.close();
    store = new SqliteStore(home);
    await writeFile(path.join(cwd, "table.ts"), "Changed after the successful handoff");
    const reopened = createPonderDesktopSourceStore(home);
    const retained = await reopened.inspect(source, "table.ts");
    expect(retained.text).toBe("export const preview = 'expandable';\n");
    await writeFile(path.join(cwd, "unchanged.ts"), "export const context = 'later';\n");
    await git("add", "table.ts", "unchanged.ts", "new.ts", "removed.ts");
    await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Later checkout");
    expect((await reopened.inspect(source, "unchanged.ts")).text).toBe("export const context = 'original';\n");
    await expect(reopened.inspect(source, "removed.ts")).rejects.toThrow("deleted");
    const reviewer = { ...session, id: "reviewer", provider: "codex" as const };
    const operation = {
      origin: { scope: owner },
      target: { workspaceId: "project" },
      workflow: {
        kind: "review",
        role: "successor",
        handoffId: "group",
        title: "Review",
        prerequisiteOperationId: "prerequisite",
        prerequisiteSessionId: "implementer",
        source,
      },
    } as unknown as PonderDesktopOperation;
    await assertDesktopWorkflowSource(operation, reviewer, store, reopened);
    await expect(assertDesktopWorkflowSource({ ...operation, workflow: { ...operation.workflow!, source: undefined } }, reviewer, store, reopened)).rejects.toThrow("source_missing");
    await expect(
      assertDesktopWorkflowSource(
        {
          ...operation,
          workflow: { ...operation.workflow!, source: { ...source, turnId: "older-turn" } },
        },
        reviewer,
        store,
        reopened,
      ),
    ).rejects.toThrow("not_committed");
    await expect(
      assertDesktopWorkflowSource(
        operation,
        { ...reviewer, localProjectId: "other-project" },
        store,
        reopened,
      ),
    ).rejects.toThrow("workspace_changed");
    await expect(reopened.inspect(source, "../outside")).rejects.toThrow("Invalid");
    await expect(reopened.inspect(source, ".env.fixture")).rejects.toThrow("Invalid");
    await symlink(path.join(directory, "outside"), path.join(cwd, "escape.ts"));
    await expect(reopened.capture(session, "next-turn")).rejects.toThrow("symlink");
    await writeFile(
      path.join(
        home,
        "work",
        "evidence",
        "portable",
        retained.hash!.slice(0, 2),
        `${retained.hash}.bin`,
      ),
      "corrupted source",
    );
    await expect(reopened.inspect(source, "table.ts")).rejects.toThrow("changed");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
