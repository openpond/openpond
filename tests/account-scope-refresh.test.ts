import { expect, test, vi } from "vitest";
import { createAccountScopeRefresh } from "../apps/web/src/lib/account-scope-refresh";

test("a team/account switch discards the in-flight snapshot and a detached renderer cannot receive it", async () => {
  // A previous account reply must never restore its snapshot after an account switch.
  const replies: Array<(value: string) => void> = [];
  const apply = vi.fn();
  const refresh = createAccountScopeRefresh({
    fetch: () => new Promise<string>((resolve) => replies.push(resolve)),
    apply,
    onError: (error) => { throw error; },
  });
  const first = refresh.refresh();
  refresh.invalidate();
  const second = refresh.refresh();
  expect(replies).toHaveLength(1);
  replies[0]!("account-a / previous team");
  await Promise.resolve();
  expect(apply).not.toHaveBeenCalled();
  expect(replies).toHaveLength(2);
  replies[1]!("account-b / Example Team");
  await Promise.all([first, second]);
  expect(apply.mock.calls).toEqual([["account-b / Example Team"]]);

  const detached = refresh.refresh();
  refresh.dispose();
  replies[2]!("late reply from previous connection");
  await detached;
  expect(apply).toHaveBeenCalledTimes(1);
});
