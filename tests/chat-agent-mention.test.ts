import { describe, expect, test } from "bun:test";

import { resolveMentionedChatApp } from "../apps/web/src/hooks/useChatActions";
import {
  actionMentionMatchesForQuery,
  resolveMentionedAction,
} from "../apps/web/src/lib/action-mentions";

const apps = [
  {
    id: "app_alpha",
    name: "Alpha Bot",
  },
  {
    id: "app_beta",
    name: "beta-agent",
  },
] as never;

describe("chat app mention resolution", () => {
  test("resolves a single app id mention", () => {
    expect(resolveMentionedChatApp("use @app_beta for this sandbox", apps)?.id).toBe(
      "app_beta",
    );
  });

  test("resolves a single normalized app name mention", () => {
    expect(resolveMentionedChatApp("start @alpha-bot", apps)?.id).toBe(
      "app_alpha",
    );
  });

  test("does not choose an app when mentions are ambiguous", () => {
    expect(resolveMentionedChatApp("@app_alpha compare with @app_beta", apps)).toBeNull();
  });
});

const supportAction = {
  id: "help-me-keep-track-of-open-customer-support-item.chat",
  label: "Chat",
  description: "Track, summarize, and filter open customer support items from committed local fixtures.",
  implementation: {
    type: "openpond-profile-action",
    actionId: "help-me-keep-track-of-open-customer-support-item.chat",
  },
};

describe("profile action mention resolution", () => {
  test("resolves generated profile actions by profile-qualified action id", () => {
    const resolved = resolveMentionedAction(
      "@help-me-keep-track-of-open-customer-support-item Which open customer support items need attention first?",
      [supportAction],
    );

    expect(resolved?.action.id).toBe("help-me-keep-track-of-open-customer-support-item.chat");
    expect(resolved?.mention).toBe("help-me-keep-track-of-open-customer-support-item");
    expect(resolved?.prompt).toBe("Which open customer support items need attention first?");
  });

  test("finds generated support actions by useful catalog aliases", () => {
    expect(actionMentionMatchesForQuery([supportAction], "support").map((action) => action.id)).toEqual([
      "help-me-keep-track-of-open-customer-support-item.chat",
    ]);
    expect(resolveMentionedAction("@support summarize open issues", [supportAction])?.action.id).toBe(
      "help-me-keep-track-of-open-customer-support-item.chat",
    );
  });

  test("does not choose an action when mentions are ambiguous", () => {
    const billingSupportAction = {
      id: "billing-support.chat",
      label: "Billing Support",
      description: "Summarize billing support escalations.",
      implementation: {
        type: "openpond-profile-action",
        actionId: "billing-support.chat",
      },
    };

    expect(resolveMentionedAction("@support summarize open issues", [supportAction, billingSupportAction])).toBeNull();
  });
});
