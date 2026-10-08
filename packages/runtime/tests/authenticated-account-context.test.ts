import { afterEach, expect, test, vi } from "vitest";
import type { RuntimeAccountContext } from "../src/types.js";
import { toAccountState } from "../src/account-state.js";

const mocks = vi.hoisted(() => ({ load: vi.fn(), authenticate: vi.fn() }));
vi.mock("../src/account-context.js", () => ({ loadOpenPondAccountContext: mocks.load }));
vi.mock("@openpond/cloud", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openpond/cloud")>()),
  getOpenPondAccount: mocks.authenticate,
}));
import { loadAuthenticatedOpenPondAccountContext } from "../src/authenticated-account-context.js";

afterEach(() => vi.restoreAllMocks());

// A response fetched before an account switch must never authorize the new account.
test("hydrates the authenticated owner and fences credential changes during the request", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
  const input = {
    config: {},
    profiles: [],
    account: null,
    token: "test-key-a",
    apiBaseUrl: "https://api.example.test",
    chatApiBaseUrl: "https://chat.example.test",
  };
  const context: RuntimeAccountContext = { ...input, accountState: toAccountState(input) };
  mocks.load.mockResolvedValue(context);
  mocks.authenticate.mockResolvedValue({ account: { id: "authenticated-owner" } });
  const authenticated = await loadAuthenticatedOpenPondAccountContext();
  expect(authenticated.accountState.profile?.id).toBe("authenticated-owner");
  expect(mocks.authenticate).toHaveBeenCalledWith(input.apiBaseUrl, input.token);
  await loadAuthenticatedOpenPondAccountContext();
  expect(mocks.authenticate).toHaveBeenCalledTimes(1);

  mocks.load
    .mockReset()
    .mockResolvedValueOnce(context)
    .mockResolvedValueOnce({ ...context, token: "test-key-b" });
  await expect(loadAuthenticatedOpenPondAccountContext()).rejects.toThrow(
    "openpond_account_authority_changed",
  );

  clock.mockReturnValue(7_000);
  mocks.load.mockReset().mockResolvedValue(context);
  mocks.authenticate.mockResolvedValue({ account: null });
  await expect(loadAuthenticatedOpenPondAccountContext()).rejects.toThrow(
    "openpond_authenticated_owner_unavailable",
  );
});
