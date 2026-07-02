import { describe, expect, test } from "bun:test";

import {
  normalizeSandboxRuntimeCreateInput,
  normalizeCreateInput,
  normalizeSandboxEnvRefsForApp,
} from "../apps/server/src/openpond/sandboxes";
import {
  pickSandboxChatDefaultRuntime,
  sandboxChatDefaultRuntimeMetadata,
} from "../apps/server/src/workspace-tools/workspace-tool-sandbox-actions";
import { normalizeMentionedSandboxToolRequest } from "../apps/server/src/runtime/turn-runner";

describe("sandbox env normalization", () => {
  test("accepts secret ref env mappings", () => {
    expect(
      normalizeSandboxEnvRefsForApp([
        {
          name: "FOO_API_KEY",
          secretRef: "openpond://secret/team_test/secret_test#v1",
        },
      ]),
    ).toEqual([
      {
        name: "FOO_API_KEY",
        secretRef: "openpond://secret/team_test/secret_test#v1",
      },
    ]);
  });

  test("rejects inline values before app server proxying", () => {
    expect(() =>
      normalizeSandboxEnvRefsForApp([
        {
          name: "FOO_API_KEY",
          value: "plaintext-secret",
        },
      ]),
    ).toThrow("Sandbox env entries must use secretRef, not inline values.");
  });
});

describe("sandbox create normalization", () => {
  test("rejects inline sandbox runtime settings on raw sandbox create", () => {
    expect(() =>
      normalizeCreateInput({
        sandboxRuntime: {
          projectId: "project_test",
          mode: "feature",
        },
      }),
    ).toThrow("Sandbox runtime settings must use /v1/runtimes");
  });

  test("normalizes raw sandbox create without managed workspace fields", () => {
    expect(
      normalizeCreateInput({
        projectId: "project_test",
        agentId: "agent_test",
        workspacePurpose: "change_code",
        purpose: "Change code",
        metadata: {
          source: "openpond-app-sandbox-ui",
          workspacePurpose: "change_code",
          purpose: "Change code",
        },
      }),
    ).toEqual({
      projectId: "project_test",
      agentId: "agent_test",
      metadata: {
        source: "openpond-app-sandbox-ui",
      },
    });
  });
});

describe("sandbox runtime create normalization", () => {
  test("forwards managed workspace settings without UI-only purpose labels", () => {
    expect(
      normalizeSandboxRuntimeCreateInput({
        teamId: "team_test",
        projectId: "project_test",
        agentId: "agent_test",
        mode: "feature",
        baseBranch: "master",
        promotionPolicy: "manual",
        workspacePurpose: "change_code",
        purpose: "Change code",
        metadata: {
          source: "openpond-app",
          workspacePurpose: "change_code",
          purpose: "Change code",
        },
      }),
    ).toEqual({
      teamId: "team_test",
      projectId: "project_test",
      agentId: "agent_test",
      mode: "feature",
      baseBranch: "master",
      promotionPolicy: "manual",
      metadata: {
        source: "openpond-app",
      },
    });
  });
});

describe("sandbox chat default runtime selection", () => {
  test("marks app chat runtimes as default reusable runtimes", () => {
    expect(
      sandboxChatDefaultRuntimeMetadata({
        requestId: "request_test",
        defaultRuntime: true,
        projectId: "project_test",
      }),
    ).toEqual({
      source: "openpond-app-sandbox-chat",
      openpondAppCreateRequestId: "request_test",
      openpondAppDefaultRuntime: true,
      projectId: "project_test",
    });
  });

  test("omits the reusable runtime marker for detached action sandboxes", () => {
    expect(
      sandboxChatDefaultRuntimeMetadata({
        requestId: "request_test",
        defaultRuntime: false,
        openpondAppDefaultRuntime: true,
      }),
    ).toEqual({
      source: "openpond-app-sandbox-chat",
      openpondAppCreateRequestId: "request_test",
    });
  });

  test("selects only matching non-terminal default runtimes for a project agent", () => {
    const runtime = pickSandboxChatDefaultRuntime({
      projectId: "project_test",
      agentId: "agent_test",
      mode: "feature",
      runtimes: [
        {
          id: "runtime_archived",
          projectId: "project_test",
          agentId: "agent_test",
          mode: "feature",
          status: "archived",
          metadata: { openpondAppDefaultRuntime: true },
        },
        {
          id: "runtime_other_agent",
          projectId: "project_test",
          agentId: "agent_other",
          mode: "feature",
          status: "running",
          metadata: { openpondAppDefaultRuntime: true },
        },
        {
          id: "runtime_default",
          projectId: "project_test",
          agentId: "agent_test",
          mode: "feature",
          status: "waiting_for_user",
          metadata: { openpondAppDefaultRuntime: true },
        },
      ] as never,
    });

    expect(runtime?.id).toBe("runtime_default");
  });

  test("does not select checkpointed default runtimes without rootfs snapshots", () => {
    const runtime = pickSandboxChatDefaultRuntime({
      projectId: "project_test",
      agentId: "agent_test",
      mode: "feature",
      runtimes: [
        {
          id: "runtime_checkpoint_without_snapshot",
          projectId: "project_test",
          agentId: "agent_test",
          mode: "feature",
          status: "checkpointed",
          rootfsSnapshotId: null,
          metadata: { openpondAppDefaultRuntime: true },
        },
        {
          id: "runtime_checkpoint_with_snapshot",
          projectId: "project_test",
          agentId: "agent_test",
          mode: "feature",
          status: "checkpointed",
          rootfsSnapshotId: "snapshot_test",
          metadata: { openpondAppDefaultRuntime: true },
        },
      ] as never,
    });

    expect(runtime?.id).toBe("runtime_checkpoint_with_snapshot");
  });
});

describe("sandbox mentioned app tool requests", () => {
  test("does not rewrite app mentions into sandbox-owned app requests", () => {
    const request = normalizeMentionedSandboxToolRequest({
      request: {
        action: "sandbox_create",
        source: "chat_action",
        args: {
          appId: "app_test",
          budget: { maxUsd: "0.05" },
        },
      },
      userPrompt: "@deepseek-template hello deepseek",
      mentionedApps: [
        {
          id: "app_test",
          name: "deepseek-template",
          gitRepo: "deepseek-template",
          sandbox: true,
          sandboxActionRegistry: {
            defaultActionName: "stream-chat",
            inputSchema: {
              type: "object",
              properties: {
                prompt: { type: "string" },
              },
            },
            actions: [{ name: "stream-chat" }],
          },
        } as never,
      ],
    });

    expect(request).toEqual({
      action: "sandbox_create",
      source: "chat_action",
      args: {
        appId: "app_test",
        budget: { maxUsd: "0.05" },
      },
    });
  });
});
