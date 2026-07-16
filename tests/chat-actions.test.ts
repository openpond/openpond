import { describe, expect, test } from "vitest";
import { ProviderSettingsSchema } from "@openpond/contracts";

import { sendTurnModelSelectionPayload } from "../apps/web/src/hooks/useChatActions";

describe("chat action model payloads", () => {
  test("uses the composer provider for the outgoing turn model ref", () => {
    const providerSettings = ProviderSettingsSchema.parse({
      providers: {
        openai: {
          enabled: true,
          defaultModel: "gpt-4.1",
          modelOverrides: ["gpt-5.5"],
        },
        zai: {
          enabled: true,
          defaultModel: "glm-5.2",
        },
      },
      statuses: {
        openai: {
          id: "openai",
          displayName: "OpenAI",
          enabled: true,
          available: true,
          defaultModel: "gpt-4.1",
        },
        zai: {
          id: "zai",
          displayName: "Z.ai / GLM",
          enabled: true,
          available: true,
          defaultModel: "glm-5.2",
        },
      },
    });

    expect(
      sendTurnModelSelectionPayload({
        provider: "openai",
        model: "gpt-5.5",
        providerSettings,
      }),
    ).toEqual({
      model: "gpt-5.5",
      modelRef: {
        providerId: "openai",
        modelId: "gpt-5.5",
      },
    });
  });
});
