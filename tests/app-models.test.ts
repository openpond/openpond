import { describe, expect, test } from "bun:test";
import { ProviderSettingsSchema, SubagentPreferencesSchema, type AppPreferences } from "@openpond/contracts";

import {
  DEFAULT_APP_PREFERENCES,
  chatProviderLabel,
  providerOptionsFromSettings,
  subagentModelRefForRole,
} from "../apps/web/src/lib/app-models";

describe("app model labels", () => {
  test("labels the Codex login provider distinctly from OpenAI BYOK", () => {
    expect(chatProviderLabel("codex", null)).toBe("OpenAI Codex");
    expect(providerOptionsFromSettings(null).find((option) => option.value === "codex")?.label).toBe(
      "OpenAI Codex",
    );
  });

  test("resolves subagent role model before main chat model before provider default", () => {
    const providerSettings = ProviderSettingsSchema.parse({
      providers: {
        zai: {
          enabled: true,
          defaultModel: "glm-5.2",
        },
      },
      statuses: {
        zai: {
          id: "zai",
          displayName: "Z.ai / GLM",
          enabled: true,
          available: true,
          defaultModel: "glm-5.2",
        },
      },
    });
    const preferences: AppPreferences = {
      ...DEFAULT_APP_PREFERENCES,
      defaultChatProvider: "codex",
      defaultChatModel: "gpt-5.5",
      subagents: SubagentPreferencesSchema.parse({
        roles: [
          {
            id: "coding",
            modelRef: { providerId: "zai", modelId: "glm-5.2" },
          },
          {
            id: "review",
            modelRef: null,
          },
        ],
      }),
    };

    expect(subagentModelRefForRole(preferences, "coding", providerSettings)).toEqual({
      providerId: "zai",
      modelId: "glm-5.2",
    });
    expect(subagentModelRefForRole(preferences, "review", providerSettings)).toEqual({
      providerId: "codex",
      modelId: "gpt-5.5",
    });
    expect(
      subagentModelRefForRole(
        {
          ...preferences,
          defaultChatProvider: "zai",
          defaultChatModel: "not-in-provider-cache",
          subagents: SubagentPreferencesSchema.parse({
            roles: [{ id: "coding", modelRef: null }],
          }),
        },
        "coding",
        providerSettings,
      ),
    ).toEqual({
      providerId: "zai",
      modelId: "glm-5.2",
    });
  });
});
