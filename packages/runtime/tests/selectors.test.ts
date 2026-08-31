import { describe, expect, test } from "vitest";

import { findActiveAccount } from "../src/selectors.js";
import type { RuntimeLocalConfig } from "../src/types.js";

describe("findActiveAccount", () => {
  test("uses the uniquely matching handle when the active selector has a stale base URL", () => {
    const staging = {
      handle: "account-staging",
      baseUrl: "https://staging.openpond.ai",
      apiBaseUrl: "https://staging-api.openpond.ai",
      apiKey: "opk_staging",
    };
    const config: RuntimeLocalConfig = {
      activeProfile: {
        handle: "account-staging",
        baseUrl: "https://openpond.ai",
      },
      accounts: [
        {
          handle: "account-production",
          baseUrl: "https://openpond.ai",
          apiBaseUrl: "https://api.openpond.ai",
          apiKey: "opk_production",
        },
        staging,
      ],
    };

    expect(findActiveAccount(config)).toEqual(staging);
  });

  test("fails closed instead of selecting the first account when the selector is unknown", () => {
    const config: RuntimeLocalConfig = {
      activeProfile: {
        handle: "missing-account",
        baseUrl: "https://staging.openpond.ai",
      },
      accounts: [
        {
          handle: "account-production",
          baseUrl: "https://openpond.ai",
          apiBaseUrl: "https://api.openpond.ai",
          apiKey: "opk_production",
        },
      ],
    };

    expect(findActiveAccount(config)).toBeNull();
  });

  test("fails closed when a handle is ambiguous without an exact base URL match", () => {
    const config: RuntimeLocalConfig = {
      activeProfile: {
        handle: "shared-account",
        baseUrl: "https://unknown.openpond.ai",
      },
      accounts: [
        {
          handle: "shared-account",
          baseUrl: "https://openpond.ai",
          apiBaseUrl: "https://api.openpond.ai",
          apiKey: "opk_production",
        },
        {
          handle: "shared-account",
          baseUrl: "https://staging.openpond.ai",
          apiBaseUrl: "https://staging-api.openpond.ai",
          apiKey: "opk_staging",
        },
      ],
    };

    expect(findActiveAccount(config)).toBeNull();
  });
});
