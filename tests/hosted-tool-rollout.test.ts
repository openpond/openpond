import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  hostedToolInstructionModeForProvider,
  nativeToolTransportEnabledForProvider,
  resolveHostedToolRolloutFlags,
} from "../apps/server/src/runtime/turn-runner";

const ENV_NAMES = [
  "OPENPOND_MODEL_TOOL_MODE",
  "OPENPOND_NATIVE_TOOL_TRANSPORT",
  "OPENPOND_RESOURCE_TOOLS",
  "OPENPOND_WEB_SEARCH_TOOL",
  "OPENPOND_DYNAMIC_ACTION_TOOLS",
  "OPENPOND_TEXT_TOOL_FALLBACK",
  "OPENPOND_NATIVE_TOOL_PROVIDERS",
  "OPENPOND_NATIVE_TOOL_PROVIDER_DENYLIST",
] as const;
const originalEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));

beforeEach(() => {
  for (const name of ENV_NAMES) delete process.env[name];
});

afterEach(() => {
  for (const name of ENV_NAMES) {
    const value = originalEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("hosted tool rollout flags", () => {
  test("enables native tools for verified providers in auto mode", () => {
    const flags = resolveHostedToolRolloutFlags();

    expect(flags.webSearchTool).toBe(true);
    expect(flags.dynamicActionTools).toBe(true);
    expect(nativeToolTransportEnabledForProvider(flags, "openpond")).toBe(true);
    expect(nativeToolTransportEnabledForProvider(flags, "openrouter")).toBe(true);
    expect(nativeToolTransportEnabledForProvider(flags, "custom-openai-compatible")).toBe(false);
  });

  test("supports explicit native, fallback, and provider override modes", () => {
    expect(
      nativeToolTransportEnabledForProvider(
        resolveHostedToolRolloutFlags({ toolMode: "native" }),
        "custom-openai-compatible",
      ),
    ).toBe(true);
    expect(
      nativeToolTransportEnabledForProvider(
        resolveHostedToolRolloutFlags({ toolMode: "text_fallback" }),
        "openrouter",
      ),
    ).toBe(false);
    expect(
      nativeToolTransportEnabledForProvider(
        resolveHostedToolRolloutFlags({
          nativeToolProviderAllowlist: ["custom-openai-compatible"],
        }),
        "custom-openai-compatible",
      ),
    ).toBe(true);
    expect(
      nativeToolTransportEnabledForProvider(
        resolveHostedToolRolloutFlags({
          nativeToolProviderDenylist: ["openrouter"],
        }),
        "openrouter",
      ),
    ).toBe(false);
  });

  test("uses resource-only text fallback when native resource tools are active", () => {
    expect(
      hostedToolInstructionModeForProvider(resolveHostedToolRolloutFlags(), "openrouter"),
    ).toBe("resource_text_fallback");
    expect(
      hostedToolInstructionModeForProvider(resolveHostedToolRolloutFlags(), "custom-openai-compatible"),
    ).toBe("full_text_fallback");
    expect(
      hostedToolInstructionModeForProvider(
        resolveHostedToolRolloutFlags({ textToolFallback: false }),
        "openrouter",
      ),
    ).toBe("none");
    expect(
      hostedToolInstructionModeForProvider(
        resolveHostedToolRolloutFlags({ toolMode: "text_fallback" }),
        "openrouter",
      ),
    ).toBe("full_text_fallback");
  });
});
