import { describe, expect, test } from "vitest";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  readLocalWorkspaceResource,
  readSessionResource,
  searchLocalWorkspaceResources,
  searchSessionResources,
} from "../apps/server/src/openpond/resources";

async function tempWorkspace(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "openpond-resources-"));
}

describe("OpenPond resource read/search", () => {
  test("reads workspace file refs with content and truncation metadata", async () => {
    const repoPath = await tempWorkspace();
    await mkdir(path.join(repoPath, "src"), { recursive: true });
    await writeFile(path.join(repoPath, "src", "index.ts"), "export const answer = 42;\n");

    const result = await readLocalWorkspaceResource({
      repoPath,
      request: { ref: "workspace:file:src/index.ts" },
    });

    expect(result).toMatchObject({
      ref: "workspace:file:src/index.ts",
      kind: "workspace.file",
      title: "src/index.ts",
      contentType: "text/plain",
      truncation: { truncated: false },
    });
    expect(result.contentText).toContain("answer = 42");
    expect(result.metadata).toMatchObject({ path: "src/index.ts", binary: false });
    expect(result.relatedRefs).toContain("workspace:dir:src");
  });

  test("rejects resource refs that escape the workspace", async () => {
    const repoPath = await tempWorkspace();
    await writeFile(path.join(repoPath, "package.json"), "{}\n");

    await expect(
      readLocalWorkspaceResource({
        repoPath,
        request: { ref: "workspace:file:../package.json" },
      }),
    ).rejects.toThrow("Resource path");
  });

  test("does not follow symlinks outside the workspace", async () => {
    const repoPath = await tempWorkspace();
    const outsidePath = path.join(tmpdir(), `openpond-resource-outside-${Date.now()}.txt`);
    await writeFile(outsidePath, "outside\n");
    await symlink(outsidePath, path.join(repoPath, "outside.txt"));

    await expect(
      readLocalWorkspaceResource({
        repoPath,
        request: { ref: "workspace:file:outside.txt" },
      }),
    ).rejects.toThrow("workspace root");
  });

  test("lists directory resources and skips generated paths", async () => {
    const repoPath = await tempWorkspace();
    await mkdir(path.join(repoPath, "src"), { recursive: true });
    await mkdir(path.join(repoPath, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(repoPath, "src", "index.ts"), "console.log('ok');\n");
    await writeFile(path.join(repoPath, "node_modules", "pkg", "index.js"), "module.exports = {};\n");

    const result = await readLocalWorkspaceResource({
      repoPath,
      request: { ref: "workspace:dir:." },
    });

    expect(result.kind).toBe("workspace.dir");
    expect(result.contentText).toContain("dir src");
    expect(result.contentText).not.toContain("node_modules");
    expect(result.relatedRefs).toContain("workspace:dir:src");
  });

  test("returns metadata-only results for binary workspace files", async () => {
    const repoPath = await tempWorkspace();
    await writeFile(path.join(repoPath, "pixel.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));

    const result = await readLocalWorkspaceResource({
      repoPath,
      request: { ref: "workspace:file:pixel.png" },
    });

    expect(result.contentText).toBeUndefined();
    expect(result.contentType).toBe("image/png");
    expect(result.metadata).toMatchObject({ binary: true, path: "pixel.png" });
    expect(result.truncation.reason).toBe("binary");
  });

  test("searches workspace paths and text with stable refs", async () => {
    const repoPath = await tempWorkspace();
    await mkdir(path.join(repoPath, "src"), { recursive: true });
    await writeFile(path.join(repoPath, "src", "chat-renderer.ts"), "export const marker = 'inline image';\n");
    await writeFile(path.join(repoPath, "README.md"), "inline image docs\n");

    const result = await searchLocalWorkspaceResources({
      repoPath,
      request: { scope: "workspace", query: "inline image", limit: 10 },
    });

    expect(result.scope).toBe("workspace");
    expect(result.truncated).toBe(false);
    expect(result.items.map((item) => item.ref)).toContain("workspace:file:src/chat-renderer.ts");
    expect(result.items.map((item) => item.ref)).toContain("workspace:file:README.md");
    expect(result.items.some((item) => item.snippet?.includes("inline image"))).toBe(true);
  });

  test("finds a workspace file when the query is its absolute path", async () => {
    const repoPath = await tempWorkspace();
    const relativePath =
      "docs/working-docs/sandbox/2026-07-09-openpond-team-chat-dms-and-ai-invocation.md";
    await mkdir(path.join(repoPath, path.dirname(relativePath)), { recursive: true });
    await writeFile(path.join(repoPath, relativePath), "# Existing document\n");

    const result = await searchLocalWorkspaceResources({
      repoPath,
      request: { scope: "workspace", query: path.join(repoPath, relativePath), limit: 10 },
    });

    expect(result.items).toContainEqual(
      expect.objectContaining({
        ref: `workspace:file:${relativePath}`,
        metadata: expect.objectContaining({ matchKind: "path", searchMode: "exact" }),
      }),
    );
  });

  test("marks workspace search results truncated only when more matches exist", async () => {
    const repoPath = await tempWorkspace();
    await mkdir(path.join(repoPath, "src"), { recursive: true });
    await writeFile(path.join(repoPath, "src/one.ts"), "shared needle\n");
    await writeFile(path.join(repoPath, "src/two.ts"), "shared needle\n");
    await writeFile(path.join(repoPath, "src/three.ts"), "shared needle\n");

    const limited = await searchLocalWorkspaceResources({
      repoPath,
      request: { scope: "workspace", query: "shared needle", limit: 2 },
    });
    const complete = await searchLocalWorkspaceResources({
      repoPath,
      request: { scope: "workspace", query: "shared needle", limit: 5 },
    });

    expect(limited.items).toHaveLength(2);
    expect(limited.truncated).toBe(true);
    expect(complete.items).toHaveLength(3);
    expect(complete.truncated).toBe(false);
  });

  test("keeps loose workspace queries out of exact search by default", async () => {
    const repoPath = await tempWorkspace();
    await mkdir(path.join(repoPath, "src/components/chat"), { recursive: true });
    await writeFile(
      path.join(repoPath, "src/components/chat/Composer.tsx"),
      [
        "export function Composer() {",
        "  return <textarea aria-label=\"Message\" onKeyDown={sendMessage} />;",
        "}",
      ].join("\n"),
    );

    const result = await searchLocalWorkspaceResources({
      repoPath,
      request: { scope: "workspace", query: "textarea TextArea chat message send", limit: 10 },
    });

    expect(result.items).toEqual([]);
  });

  test("searches workspace resources with explicit ranked multi-term retrieval", async () => {
    const repoPath = await tempWorkspace();
    await mkdir(path.join(repoPath, "src/components/chat"), { recursive: true });
    await writeFile(
      path.join(repoPath, "src/components/chat/Composer.tsx"),
      [
        "export function Composer() {",
        "  return <textarea aria-label=\"Message\" onKeyDown={sendMessage} />;",
        "}",
      ].join("\n"),
    );
    await writeFile(
      path.join(repoPath, "src/components/chat/Messages.tsx"),
      [
        "export function UserMessage() {",
        "  return <button aria-label=\"Show more\"><ChevronDown /></button>;",
        "}",
      ].join("\n"),
    );

    const composer = await searchLocalWorkspaceResources({
      repoPath,
      request: {
        scope: "workspace",
        query: "textarea TextArea chat message send",
        limit: 10,
        filters: { mode: "ranked" },
      },
    });
    const messages = await searchLocalWorkspaceResources({
      repoPath,
      request: {
        scope: "workspace",
        query: "user message show more down arrow",
        limit: 10,
        filters: { mode: "ranked" },
      },
    });

    expect(composer.items.map((item) => item.ref)).toContain("workspace:file:src/components/chat/Composer.tsx");
    expect(messages.items.map((item) => item.ref)).toContain("workspace:file:src/components/chat/Messages.tsx");
    expect(composer.items[0]?.metadata).toMatchObject({ matchKind: "ranked", searchMode: "ranked" });
  });

  test("searches workspace resources with explicit path lookup", async () => {
    const repoPath = await tempWorkspace();
    await mkdir(path.join(repoPath, "src/components/chat"), { recursive: true });
    await mkdir(path.join(repoPath, "src/components/settings"), { recursive: true });
    await writeFile(path.join(repoPath, "src/components/chat/MessageComposer.tsx"), "export const value = 1;\n");
    await writeFile(path.join(repoPath, "src/components/settings/MessagePanel.tsx"), "export const value = 2;\n");

    const result = await searchLocalWorkspaceResources({
      repoPath,
      request: {
        scope: "workspace",
        query: "chat composer",
        limit: 10,
        filters: { mode: "path" },
      },
    });

    expect(result.items[0]).toMatchObject({
      ref: "workspace:file:src/components/chat/MessageComposer.tsx",
      metadata: { matchKind: "path", searchMode: "path" },
    });
  });

  test("searches and reads current-session event resources", () => {
    const events = [
      {
        id: "event_1",
        sessionId: "session_1",
        turnId: "turn_1",
        name: "workspace_action_result",
        timestamp: "2026-07-02T10:00:00.000Z",
        source: "chat_action",
        action: "resource_search",
        status: "completed",
        output: "Found README resources.",
      },
      {
        id: "event_other",
        sessionId: "session_2",
        name: "workspace_action_result",
        timestamp: "2026-07-02T10:00:00.000Z",
        output: "Found private resources.",
      },
    ] as const;

    const search = searchSessionResources({
      events: [...events],
      sessionId: "session_1",
      request: { scope: "events", query: "README" },
    });
    const read = readSessionResource({
      events: [...events],
      sessionId: "session_1",
      request: { ref: "event:event_1" },
    });

    expect(search.items.map((item) => item.ref)).toEqual(["event:event_1"]);
    expect(read.kind).toBe("session.event");
    expect(read.contentText).toContain("Found README resources.");
    expect(() =>
      readSessionResource({
        events: [...events],
        sessionId: "session_1",
        request: { ref: "event:event_other" },
      }),
    ).toThrow("Event resource not found");
  });

  test("searches and reads current-session message resources", () => {
    const events = [
      {
        id: "user_event",
        sessionId: "session_1",
        turnId: "turn_1",
        name: "turn.started",
        timestamp: "2026-07-02T10:00:00.000Z",
        args: { prompt: "Can images render inline?" },
      },
      {
        id: "assistant_event",
        sessionId: "session_1",
        turnId: "turn_1",
        name: "assistant.delta",
        timestamp: "2026-07-02T10:00:01.000Z",
        output: "Images should render with markdown image syntax.",
      },
    ] as const;

    const search = searchSessionResources({
      events: [...events],
      sessionId: "session_1",
      request: { scope: "messages", query: "markdown image" },
    });
    const read = readSessionResource({
      events: [...events],
      sessionId: "session_1",
      request: { ref: "message:assistant_event" },
    });

    expect(search.items.map((item) => item.ref)).toEqual(["message:assistant_event"]);
    expect(read.kind).toBe("session.message.assistant");
    expect(read.contentText).toContain("markdown image syntax");
    expect(read.relatedRefs).toContain("event:user_event");
  });

  test("searches and reads current-session goal context resources", () => {
    const events = [
      {
        id: "goal_event",
        sessionId: "session_1",
        turnId: "turn_1",
        name: "diagnostic",
        timestamp: "2026-07-02T10:00:00.000Z",
        output: "Ship native resource tools.",
        data: {
          kind: "thread_goal",
          goal: {
            id: "goal_1",
            objective: "Ship native resource tools.",
            status: "active",
          },
        },
      },
      {
        id: "goal_context_event",
        sessionId: "session_1",
        turnId: "turn_1",
        name: "diagnostic",
        timestamp: "2026-07-02T10:00:01.000Z",
        output: "<goal_context>\nKeep resource refs durable.\n</goal_context>",
        data: { kind: "goal_context" },
      },
      {
        id: "other_goal_event",
        sessionId: "session_2",
        name: "diagnostic",
        timestamp: "2026-07-02T10:00:00.000Z",
        data: {
          kind: "thread_goal",
          goal: {
            id: "private_goal",
            objective: "Private goal",
            status: "active",
          },
        },
      },
    ] as const;

    const search = searchSessionResources({
      events: [...events],
      sessionId: "session_1",
      request: { scope: "goal-context", query: "resource" },
    });
    const threadGoal = readSessionResource({
      events: [...events],
      sessionId: "session_1",
      request: { ref: "goal-context:goal_event" },
    });
    const plainGoalContext = readSessionResource({
      events: [...events],
      sessionId: "session_1",
      request: { ref: "goal-context:goal_context_event" },
    });

    expect(search.items.map((item) => item.ref)).toEqual([
      "goal-context:goal_event",
      "goal-context:goal_context_event",
    ]);
    expect(search.items.map((item) => item.ref)).not.toContain("goal-context:other_goal_event");
    expect(threadGoal.kind).toBe("goal-context.runtime");
    expect(threadGoal.metadata).toMatchObject({ goalId: "goal_1", status: "active" });
    expect(threadGoal.contentText).toContain("Ship native resource tools");
    expect(plainGoalContext.contentText).toContain("Keep resource refs durable");
  });

  test("searches and reads primary and supporting goal context documents by role", () => {
    const events = [
      {
        id: "goal_event",
        sessionId: "session_1",
        turnId: "turn_1",
        name: "diagnostic",
        timestamp: "2026-07-02T10:00:00.000Z",
        output: "Goal updated.",
        data: {
          kind: "thread_goal",
          goal: {
            id: "goal_1",
            objective: "Create a SharePoint agent.",
            status: "active",
            contextItems: [
              {
                id: "primary_spec",
                kind: "document",
                role: "primary_context",
                title: "Create SharePoint Agent",
                bindingMode: "pinned",
                required: true,
                contentHash: "sha256:primary",
                contentText: "# Create SharePoint Agent\n\nPrimary requirements.",
                source: {
                  kind: "profile_goal_doc",
                  profileProjectId: "project_profile",
                  profileName: "default",
                  profileSourcePath: "profiles/default",
                  path: "profiles/default/goals/work/create-sharepoint-agent.md",
                  sourceRef: "master",
                  commitSha: "abc123",
                },
              },
              {
                id: "create_agent_playbook",
                kind: "document",
                role: "supporting_context",
                title: "Create Agent Playbook",
                bindingMode: "live",
                required: false,
                revisionId: "rev-playbook",
                markdown: "# Create Agent Playbook\n\nSupporting checklist.",
                source: {
                  kind: "profile_goal_doc",
                  profileProjectId: "project_profile",
                  profileName: "default",
                  profileSourcePath: "profiles/default",
                  path: "profiles/default/goals/create-agent.md",
                  sourceRef: "master",
                },
              },
            ],
          },
        },
      },
    ] as const;

    const primarySearch = searchSessionResources({
      events: [...events],
      sessionId: "session_1",
      request: {
        scope: "goal-context",
        query: "SharePoint",
        filters: { role: "primary_context" },
      },
    });
    const supportingSearch = searchSessionResources({
      events: [...events],
      sessionId: "session_1",
      request: {
        scope: "goal-context",
        query: "playbook",
        filters: { role: "supporting_context" },
      },
    });
    const primaryDoc = readSessionResource({
      events: [...events],
      sessionId: "session_1",
      request: { ref: "goal-context:primary_spec" },
    });
    const supportingDoc = readSessionResource({
      events: [...events],
      sessionId: "session_1",
      request: { ref: "goal-context:create_agent_playbook" },
    });

    expect(primarySearch.items.map((item) => item.ref)).toContain("goal-context:primary_spec");
    expect(primarySearch.items.map((item) => item.ref)).not.toContain("goal-context:create_agent_playbook");
    expect(supportingSearch.items.map((item) => item.ref)).toEqual(["goal-context:create_agent_playbook"]);
    expect(primaryDoc.kind).toBe("goal-context.document");
    expect(primaryDoc.contentText).toContain("Primary requirements");
    expect(primaryDoc.metadata).toMatchObject({
      documentId: "primary_spec",
      revisionId: "abc123",
      title: "Create SharePoint Agent",
      role: "primary_context",
      bindingMode: "pinned",
      required: true,
      contentHash: "sha256:primary",
      source: {
        path: "profiles/default/goals/work/create-sharepoint-agent.md",
        commitSha: "abc123",
      },
    });
    expect(supportingDoc.metadata).toMatchObject({
      documentId: "create_agent_playbook",
      revisionId: "rev-playbook",
      role: "supporting_context",
      bindingMode: "live",
    });
  });

  test("searches and reads artifact refs from current-session events", () => {
    const events = [
      {
        id: "artifact_event",
        sessionId: "session_1",
        turnId: "turn_1",
        name: "workspace_action_result",
        timestamp: "2026-07-02T10:00:00.000Z",
        output: "Generated artifacts.",
        data: {
          artifactRefs: ["reports/summary.txt", "images/chart.png"],
          artifacts: [
            {
              path: "reports/summary.txt",
              title: "Summary report",
              contentText: "Detailed benchmark summary.",
            },
          ],
        },
      },
      {
        id: "other_artifact_event",
        sessionId: "session_2",
        name: "workspace_action_result",
        timestamp: "2026-07-02T10:00:00.000Z",
        data: { artifactRefs: ["private/report.txt"] },
      },
    ] as const;

    const search = searchSessionResources({
      events: [...events],
      sessionId: "session_1",
      request: { scope: "artifacts", query: "summary" },
    });
    const textArtifact = readSessionResource({
      events: [...events],
      sessionId: "session_1",
      request: { ref: "artifact:artifact_event:reports%2Fsummary.txt" },
    });
    const binaryArtifact = readSessionResource({
      events: [...events],
      sessionId: "session_1",
      request: { ref: "artifact:artifact_event:images%2Fchart.png" },
    });

    expect(search.items.map((item) => item.ref)).toContain("artifact:artifact_event:reports%2Fsummary.txt");
    expect(search.items.map((item) => item.ref)).not.toContain("artifact:other_artifact_event:private%2Freport.txt");
    expect(textArtifact.kind).toBe("event.artifact");
    expect(textArtifact.contentText).toContain("Detailed benchmark summary.");
    expect(binaryArtifact.contentText).toBeUndefined();
    expect(binaryArtifact.truncation.reason).toBe("binary-or-external-artifact");
  });

  test("searches and reads check output refs from current-session events", () => {
    const events = [
      {
        id: "checks_event",
        sessionId: "session_1",
        turnId: "turn_1",
        name: "workspace_action_result",
        timestamp: "2026-07-02T10:00:00.000Z",
        data: {
          checks: [
            {
              ok: false,
              command: "pnpm test",
              code: 1,
              stdout: "failing assertion",
              stderr: "expected true",
            },
          ],
        },
      },
    ] as const;

    const search = searchSessionResources({
      events: [...events],
      sessionId: "session_1",
      request: { scope: "artifacts", query: "pnpm test" },
    });
    const read = readSessionResource({
      events: [...events],
      sessionId: "session_1",
      request: { ref: "event:check-result:checks_event:0" },
    });

    expect(search.items.map((item) => item.ref)).toEqual(["event:check-result:checks_event:0"]);
    expect(read.kind).toBe("event.check-result");
    expect(read.contentText).toContain("$ pnpm test");
    expect(read.contentText).toContain("expected true");
  });

  test("truncates large check output refs with explicit metadata", () => {
    const largeStdout = `${"line\n".repeat(200)}needle at tail`;
    const events = [
      {
        id: "large_checks_event",
        sessionId: "session_1",
        turnId: "turn_1",
        name: "workspace_action_result",
        timestamp: "2026-07-02T10:00:00.000Z",
        data: {
          checks: [
            {
              ok: true,
              command: "pnpm test",
              code: 0,
              stdout: largeStdout,
              stderr: "",
            },
          ],
        },
      },
    ] as const;

    const read = readSessionResource({
      events: [...events],
      sessionId: "session_1",
      request: { ref: "event:check-result:large_checks_event:0", maxBytes: 80 },
    });

    expect(read.kind).toBe("event.check-result");
    expect(read.truncation).toMatchObject({
      truncated: true,
      reason: "maxBytes",
      returnedBytes: 80,
    });
    expect(read.contentText).toContain("[resource truncated]");
  });

  test("throws for missing artifact refs in the current session", () => {
    const events = [
      {
        id: "artifact_event",
        sessionId: "session_1",
        turnId: "turn_1",
        name: "workspace_action_result",
        timestamp: "2026-07-02T10:00:00.000Z",
        data: {
          artifactRefs: ["reports/summary.txt"],
        },
      },
    ] as const;

    expect(() =>
      readSessionResource({
        events: [...events],
        sessionId: "session_1",
        request: { ref: "artifact:artifact_event:missing.txt" },
      }),
    ).toThrow("Artifact resource not found");
  });
});
