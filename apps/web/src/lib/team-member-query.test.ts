import { QueryObserver } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import type { TeamChatMember } from "@openpond/contracts";
import { api } from "../api";
import { createWorkspaceQueryClient } from "./query-client";
import { teamMemberQueryOptions } from "./team-member-query";

// Switching teams/accounts during a slow read must never show the previous
// directory; revisiting an already loaded team should not wait on another read.
it("reuses warm member lists and cancels isolated reads when workspace or account changes", async () => {
  const queries = createWorkspaceQueryClient();
  const connection = { serverUrl: "http://local.invalid", token: "fixture", platform: "linux" };
  const member: TeamChatMember = { userId: "member-a", name: "Alex", role: "member", handle: null, image: null };
  const reads: Array<{ teamId: string; signal?: AbortSignal; finish: (members: TeamChatMember[]) => void }> = [];
  const read = vi.spyOn(api, "teamChatMembers").mockImplementation((_connection, teamId, signal) =>
    new Promise(resolve => reads.push({ teamId, signal, finish: members => resolve({ members }) })),
  );
  const scope = { connection, accountScopeKey: "account-a", currentUserId: "viewer", teamId: "team-a" };
  const first = teamMemberQueryOptions(scope);
  const observer = new QueryObserver(queries, first);
  const unsubscribe = observer.subscribe(() => undefined);
  try {
    const sameRead = queries.fetchQuery(first);
    expect(read).toHaveBeenCalledTimes(1);
    reads[0]!.finish([member]);
    await sameRead;
    expect(observer.getCurrentResult().data).toEqual([member]);

    observer.setOptions(teamMemberQueryOptions({ ...scope, teamId: "team-b" }));
    expect(observer.getCurrentResult().data).toBeUndefined();
    expect(reads[1]!.teamId).toBe("team-b");
    observer.setOptions(first);
    expect(reads[1]!.signal?.aborted).toBe(true);
    expect(observer.getCurrentResult().data).toEqual([member]);
    expect(read).toHaveBeenCalledTimes(2);
    reads[1]!.finish([{ ...member, userId: "member-b" }]);
    await Promise.resolve();
    expect(observer.getCurrentResult().data).toEqual([member]);

    const otherAccount = teamMemberQueryOptions({ ...scope, accountScopeKey: "account-b" });
    observer.setOptions(otherAccount);
    expect(observer.getCurrentResult().data).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(3);
    const accountRead = queries.fetchQuery(otherAccount);
    reads[2]!.finish([]);
    await accountRead;
    expect(observer.getCurrentResult().data).toEqual([]);
    expect(queries.getQueryData(first.queryKey)).toEqual([member]);
  } finally {
    unsubscribe();
    queries.clear();
    read.mockRestore();
  }
});
