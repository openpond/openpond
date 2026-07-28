import { describe, expect, test, vi } from "vitest";
import { emptyOpenPondProfileState, type OpenPondProfileRef, type Session } from "@openpond/contracts";
import { selectComposerProfileTransaction } from "../apps/web/src/lib/profile-selection-transaction";

const originalRef: OpenPondProfileRef = {
  source: "local",
  repositoryId: "/profiles/original",
  profileId: "default",
};
const nextRef: OpenPondProfileRef = {
  source: "github",
  repositoryId: "duckailabs/ducky-capital-skills",
  profileId: "default",
};
const session = {
  id: "session-1",
  currentProfile: originalRef,
} as Session;

describe("composer Profile selection transaction", () => {
  test("pins the task before updating the device default", async () => {
    const calls: string[] = [];
    const result = await selectComposerProfileTransaction({
      ref: nextRef,
      session,
      patchSession: async (_sessionId, currentProfile) => {
        calls.push(`patch:${currentProfile?.repositoryId}`);
        return { ...session, currentProfile };
      },
      selectProfile: async (ref) => {
        calls.push(`select:${ref.repositoryId}`);
        return { profile: emptyOpenPondProfileState(), library: { lastUsed: ref, profiles: [] } };
      },
    });
    expect(calls).toEqual([
      "patch:duckailabs/ducky-capital-skills",
      "select:duckailabs/ducky-capital-skills",
    ]);
    expect(result.session?.currentProfile).toEqual(nextRef);
  });

  test("restores the task Profile if updating the default fails", async () => {
    const patchSession = vi.fn(async (_sessionId: string, currentProfile: OpenPondProfileRef | null) => ({
      ...session,
      currentProfile,
    }));
    await expect(selectComposerProfileTransaction({
      ref: nextRef,
      session,
      patchSession,
      selectProfile: async () => {
        throw new Error("config write failed");
      },
    })).rejects.toThrow("config write failed");
    expect(patchSession).toHaveBeenNthCalledWith(1, session.id, nextRef);
    expect(patchSession).toHaveBeenNthCalledWith(2, session.id, originalRef);
  });
});
