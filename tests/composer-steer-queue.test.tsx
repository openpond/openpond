import { describe, expect, test } from "vitest";
import type { RuntimeEvent } from "@openpond/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Composer } from "../apps/web/src/components/chat/Composer";
import {
  composerSteerDraftsAfterSubmit,
  composerSteerDraftsForScope,
  composerSteerPreview,
  createComposerSteerDraft,
  replaceComposerSteerDraftForEdit,
  updateComposerSteerDraftScope,
  type ComposerSteerDraft,
} from "../apps/web/src/components/chat/composer-steer-queue";
import type { ContextWindowStatus } from "../apps/web/src/lib/context-window";
import type { GoalRuntimeStatus } from "../apps/web/src/lib/goal-runtime";
import type { WorkspaceTargetState } from "../apps/web/src/lib/workspace-location";
import { latestTurnCompletionState } from "../apps/web/src/lib/turn-completion-state";

const noop = () => undefined;

describe("composer steer queue", () => {
  test("creates stable text previews for compact rows", () => {
    expect(composerSteerPreview("  tighten   the spacing\n\nand align rows  ")).toBe(
      "tighten the spacing and align rows",
    );
    expect(composerSteerPreview("abcdefghijklmnopqrstuvwxyz", 12)).toBe("abcdefghijk...");
  });

  test("classifies latest turn completion state", () => {
    expect(latestTurnCompletionState([
      event("started", "turn.started", "turn_a"),
      event("completed", "turn.completed", "turn_a"),
    ])).toBe("completed");

    expect(latestTurnCompletionState([
      event("started", "turn.started", "turn_a"),
      event("failed", "turn.failed", "turn_a"),
    ])).toBe("blocked");

    expect(latestTurnCompletionState([
      event("started", "turn.started", "turn_a"),
    ])).toBe("pending");
  });

  test("renders staged steer drafts above the active goal strip", () => {
    const queuedDraft = draft("draft_order", "queued steer before goal");
    const markup = renderToStaticMarkup(
      createElement(Composer, {
        mode: "dock",
        prompt: "",
        mentionApps: [],
        selectedMentionAppId: null,
        contextWindowStatus: contextWindowStatus(),
        goalRuntime: goalRuntime(),
        initialSteerDrafts: [queuedDraft],
        busy: true,
        running: true,
        connection: null,
        provider: "openpond",
        model: "openpond-chat",
        projectTarget: projectTarget(),
        actionCatalog: [],
        workspaceTarget: workspaceTarget(),
        codexPermissionMode: "default",
        codexReasoningEffort: "medium",
        onProviderChange: noop,
        onProjectTargetChange: noop,
        onWorkspaceTargetChange: noop,
        onModelChange: noop,
        onCodexPermissionModeChange: noop,
        onCodexReasoningEffortChange: noop,
        onPromptChange: noop,
        onMentionAppSelect: noop,
        showToast: noop,
        onSubmit: async () => true,
        onStop: noop,
      }),
    );

    const queueIndex = markup.indexOf('class="composer-steer-stack"');
    const goalIndex = markup.indexOf("composer-goal-strip");
    const inputIndex = markup.indexOf('class="composer-input-shell"');
    expect(queueIndex).toBeGreaterThan(-1);
    expect(goalIndex).toBeGreaterThan(queueIndex);
    expect(inputIndex).toBeGreaterThan(goalIndex);
    expect(markup).toContain('aria-label="Steer: queued steer before goal"');
    expect(markup).toContain('aria-label="Delete steer draft"');
    expect(markup).toContain('aria-label="Pause goal"');
    expect(markup).toContain('contentEditable="true"');
  });

  test("keeps Stop available while a response is running", () => {
    const markup = renderToStaticMarkup(
      createElement(Composer, {
        mode: "dock",
        prompt: "add one more detail",
        mentionApps: [],
        selectedMentionAppId: null,
        contextWindowStatus: contextWindowStatus(),
        busy: true,
        running: true,
        connection: null,
        provider: "openpond",
        model: "openpond-chat",
        projectTarget: projectTarget(),
        actionCatalog: [],
        workspaceTarget: workspaceTarget(),
        codexPermissionMode: "default",
        codexReasoningEffort: "medium",
        onProviderChange: noop,
        onProjectTargetChange: noop,
        onWorkspaceTargetChange: noop,
        onModelChange: noop,
        onCodexPermissionModeChange: noop,
        onCodexReasoningEffortChange: noop,
        onPromptChange: noop,
        onMentionAppSelect: noop,
        showToast: noop,
        onSubmit: async () => true,
        onStop: noop,
      }),
    );

    expect(markup).not.toContain('aria-label="Queue steer draft"');
    expect(markup).not.toContain("Steer active response");
    expect(markup).toContain('aria-label="Stop response"');
  });

  test("moves a queued edit back to the composer without losing a typed message", () => {
    const drafts = [
      draft("draft_a", "message to edit"),
      draft("draft_b", "another queued steer"),
    ];

    expect(
      replaceComposerSteerDraftForEdit(drafts, "draft_a").map(
        (item) => item.prompt,
      ),
    ).toEqual(["another queued steer"]);
    expect(
      replaceComposerSteerDraftForEdit(drafts, "draft_a", "currently typed message").map(
        (item) => item.prompt,
      ),
    ).toEqual(["currently typed message", "another queued steer"]);
  });

  test("removes queued drafts only after submit success", () => {
    const drafts = [
      draft("draft_a", "first queued steer"),
      draft("draft_b", "second queued steer"),
    ];

    expect(composerSteerDraftsAfterSubmit(drafts, "draft_a", false)).toBe(drafts);
    expect(composerSteerDraftsAfterSubmit(drafts, "draft_a", true).map((item) => item.id)).toEqual([
      "draft_b",
    ]);
  });

  test("keeps queued drafts isolated by composer scope", () => {
    const firstScopeDraft = draft("draft_scope_a", "stay with conversation A");
    const secondScopeDraft = draft("draft_scope_b", "stay with conversation B");

    const withFirstScope = updateComposerSteerDraftScope(
      {},
      "session_a",
      (current) => [...current, firstScopeDraft],
    );
    const withBothScopes = updateComposerSteerDraftScope(
      withFirstScope,
      "session_b",
      (current) => [...current, secondScopeDraft],
    );

    expect(composerSteerDraftsForScope(withBothScopes, "session_a").map((item) => item.prompt)).toEqual([
      "stay with conversation A",
    ]);
    expect(composerSteerDraftsForScope(withBothScopes, "session_b").map((item) => item.prompt)).toEqual([
      "stay with conversation B",
    ]);
    expect(composerSteerDraftsForScope(withBothScopes, "session_c")).toEqual([]);
  });
});

function draft(id: string, prompt: string): ComposerSteerDraft {
  return createComposerSteerDraft(prompt, {
    id,
    now: "2026-07-04T20:10:00.000Z",
  });
}

function event(id: string, name: RuntimeEvent["name"], turnId: string): RuntimeEvent {
  return {
    id,
    name,
    sessionId: "session_1",
    timestamp: "2026-07-04T20:12:00.000Z",
    turnId,
  };
}

function contextWindowStatus(): ContextWindowStatus {
  return {
    usedTokens: 2400,
    maxTokens: 128000,
    percent: 2,
    summary: "2% full",
    tokensLabel: "2.4k / 128k tokens used",
    detail: null,
    tooltip: "Context window: 2% full.",
    tone: "low",
  };
}

function goalRuntime(): GoalRuntimeStatus {
  return {
    objective: "Ship steer queue",
    status: "active",
    timeUsedSeconds: 60,
    tokensUsed: null,
    tokenBudget: null,
    actionLabel: "Pursuing goal",
    timeLabel: "1m",
    label: "Goal 1m",
    detail: "Active",
    tooltip: "Pursuing goal: Ship steer queue",
    tone: "active",
  };
}

function projectTarget() {
  return {
    value: "none",
    label: "No project",
    detail: "General chat",
    options: [{ value: "none", label: "No project", detail: "General chat", kind: "none" as const }],
    busy: false,
  };
}

function workspaceTarget(): WorkspaceTargetState {
  return {
    value: "local",
    label: "Local",
    detail: "Use local workspace",
    options: [
      { value: "local", label: "Local", detail: "Use local workspace", disabled: false },
      { value: "cloud", label: "Cloud", detail: "Use cloud workspace", disabled: false },
    ],
    action: { value: "cloud", label: "Move to Cloud", detail: "Create a cloud workspace", disabled: false },
    busy: false,
  };
}
