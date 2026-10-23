import { describe, expect, test } from "vitest";

import { findActiveAccount } from "../src/selectors.js";
import type { RuntimeLocalConfig } from "../src/types.js";

describe("findActiveAccount", () => {
  test("uses the uniquely matching handle when the active selector has a stale base URL", () => {
    const alternate = {
      handle: "account-alternate",
      baseUrl: "https://web.example.test",
      apiBaseUrl: "https://api.example.test",
      apiKey: "opk_alternate",
    };
    const config: RuntimeLocalConfig = {
      activeProfile: {
        handle: "account-alternate",
        baseUrl: "https://openpond.ai",
      },
      accounts: [
        {
          handle: "account-primary",
          baseUrl: "https://openpond.ai",
          apiBaseUrl: "https://api.openpond.ai",
          apiKey: "opk_primary",
        },
        alternate,
      ],
    };

    expect(findActiveAccount(config)).toEqual(alternate);
  });

  test("fails closed instead of selecting the first account when the selector is unknown", () => {
    const config: RuntimeLocalConfig = {
      activeProfile: {
        handle: "missing-account",
        baseUrl: "https://web.example.test",
      },
      accounts: [
        {
          handle: "account-primary",
          baseUrl: "https://openpond.ai",
          apiBaseUrl: "https://api.openpond.ai",
          apiKey: "opk_primary",
        },
      ],
    };

    expect(findActiveAccount(config)).toBeNull();
  });

  test("fails closed when a handle is ambiguous without an exact base URL match", () => {
    const config: RuntimeLocalConfig = {
      activeProfile: {
        handle: "shared-account",
        baseUrl: "https://unknown.example.test",
      },
      accounts: [
        {
          handle: "shared-account",
          baseUrl: "https://openpond.ai",
          apiBaseUrl: "https://api.openpond.ai",
          apiKey: "opk_primary",
        },
        {
          handle: "shared-account",
          baseUrl: "https://web.example.test",
          apiBaseUrl: "https://api.example.test",
          apiKey: "opk_alternate",
        },
      ],
    };

    expect(findActiveAccount(config)).toBeNull();
  });
});
