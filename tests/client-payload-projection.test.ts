import { describe, expect, it } from "vitest";

import {
  AccountStateSchema,
  emptyOpenPondProfileState,
} from "@openpond/contracts";
import {
  MAX_INLINE_AVATAR_URL_CHARS,
  accountStateForClient,
  profileLibraryForClient,
  profileStateForClient,
} from "../apps/server/src/api/client-payload-projection.js";

const changedFile = {
  path: "src/example.ts",
  originalPath: null,
  indexStatus: null,
  worktreeStatus: "M",
  status: "modified",
  category: "modified" as const,
};

describe("client payload projection", () => {
  it("preserves exact Profile file counts without sending file lists", () => {
    const profile = emptyOpenPondProfileState();
    profile.git = {
      isRepo: true,
      branch: "main",
      head: "abc",
      shortHead: "abc",
      dirty: true,
      upstream: null,
      ahead: 0,
      behind: 0,
      remoteUrl: null,
      files: [changedFile, { ...changedFile, path: "src/other.ts" }],
      error: null,
    };
    profile.diff.files = [changedFile];

    const projected = profileStateForClient(profile);

    expect(projected.git?.files).toEqual([]);
    expect(projected.git?.fileCount).toBe(2);
    expect(projected.diff.files).toEqual([]);
    expect(projected.diff.fileCount).toBe(1);
    expect(profile.git.files).toHaveLength(2);
    expect(profile.diff.files).toHaveLength(1);
  });

  it("projects every Profile library entry without dropping metadata", () => {
    const profile = emptyOpenPondProfileState();
    profile.diff.files = [changedFile];
    const library = {
      lastUsed: {
        source: "local" as const,
        repositoryId: "/tmp/profile",
        profileId: "default",
      },
      profiles: [
        {
          ref: {
            source: "local" as const,
            repositoryId: "/tmp/profile",
            profileId: "default",
          },
          name: "Default",
          repoPath: "/tmp/profile",
          sourcePath: "/tmp/profile/profiles/default",
          state: profile,
        },
      ],
    };

    const projected = profileLibraryForClient(library);

    expect(projected.lastUsed).toEqual(library.lastUsed);
    expect(projected.profiles[0]?.name).toBe("Default");
    expect(projected.profiles[0]?.state.diff.fileCount).toBe(1);
    expect(projected.profiles[0]?.state.diff.files).toEqual([]);
  });

  it("drops only oversized inline account avatars", () => {
    const oversized = `data:image/png;base64,${"a".repeat(
      MAX_INLINE_AVATAR_URL_CHARS
    )}`;
    const account = AccountStateSchema.parse({
      state: "signed_in",
      activeProfile: { handle: "person", baseUrl: null },
      label: "Person",
      email: null,
      avatarUrl: oversized,
      environment: null,
      baseUrl: null,
      apiBaseUrl: null,
      chatApiBaseUrl: null,
      creditsLabel: null,
      profile: {
        id: null,
        email: null,
        name: "Person",
        handle: "person",
        image: oversized,
        timezone: null,
        isAdmin: null,
        isVerified: null,
        dailyAgentAppId: null,
        dailyAgentDeploymentId: null,
        credits: null,
      },
      products: [],
      apiHealth: null,
      accounts: [
        {
          handle: "person",
          baseUrl: null,
          apiBaseUrl: null,
          environment: null,
          isActive: true,
          authHealth: "signed_in",
          displayLabel: "Person",
          email: null,
          avatarUrl: oversized,
        },
        {
          handle: "other",
          baseUrl: null,
          apiBaseUrl: null,
          environment: null,
          isActive: false,
          authHealth: "signed_in",
          displayLabel: "Other",
          email: null,
          avatarUrl: "https://example.com/avatar.png",
        },
      ],
      error: null,
    });

    const projected = accountStateForClient(account);

    expect(projected.avatarUrl).toBeNull();
    expect(projected.profile?.image).toBeNull();
    expect(projected.accounts[0]?.avatarUrl).toBeNull();
    expect(projected.accounts[1]?.avatarUrl).toBe(
      "https://example.com/avatar.png"
    );
  });
});
