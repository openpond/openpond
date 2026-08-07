import { describe, expect, test } from "vitest";

import { accountToken } from "../packages/runtime/src/selectors";

describe("runtime account token", () => {
  test("uses the process credential for headless hosted runtimes", () => {
    expect(accountToken(null, { OPENPOND_API_KEY: " hosted-key " })).toBe(
      "hosted-key",
    );
  });

  test("keeps an explicitly selected account ahead of the process credential", () => {
    expect(
      accountToken(
        { handle: "selected", apiKey: "account-key" },
        { OPENPOND_API_KEY: "hosted-key" },
      ),
    ).toBe("account-key");
  });
});
