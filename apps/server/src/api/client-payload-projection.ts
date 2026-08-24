import type { AccountState } from "@openpond/contracts";

type ProfileFileSummary = {
  files: unknown[];
  fileCount?: number;
};

type ProfileStatePayload = {
  git: (ProfileFileSummary & Record<string, unknown>) | null;
  diff: ProfileFileSummary & Record<string, unknown>;
} & Record<string, unknown>;

type ProfileLibraryPayload<TState extends ProfileStatePayload> = {
  profiles: Array<
    {
      state: TState;
    } & Record<string, unknown>
  >;
} & Record<string, unknown>;

export const MAX_INLINE_AVATAR_URL_CHARS = 8_192;

function avatarUrlForClient(value: string | null): string | null {
  if (!value?.startsWith("data:")) return value;
  return value.length <= MAX_INLINE_AVATAR_URL_CHARS ? value : null;
}

export function accountStateForClient(account: AccountState): AccountState {
  return {
    ...account,
    avatarUrl: avatarUrlForClient(account.avatarUrl),
    accounts: account.accounts.map((candidate) => ({
      ...candidate,
      avatarUrl: avatarUrlForClient(candidate.avatarUrl),
    })),
    profile: account.profile
      ? {
          ...account.profile,
          image: avatarUrlForClient(account.profile.image),
        }
      : account.profile,
  };
}

export function profileStateForClient<TState extends ProfileStatePayload>(
  profile: TState
): TState {
  return {
    ...profile,
    git: profile.git
      ? {
          ...profile.git,
          fileCount: profile.git.fileCount ?? profile.git.files.length,
          files: [],
        }
      : null,
    diff: {
      ...profile.diff,
      fileCount: profile.diff.fileCount ?? profile.diff.files.length,
      files: [],
    },
  } as TState;
}

export function profileLibraryForClient<
  TLibrary extends ProfileLibraryPayload<ProfileStatePayload>,
>(library: TLibrary): TLibrary {
  return {
    ...library,
    profiles: library.profiles.map((entry) => ({
      ...entry,
      state: profileStateForClient(entry.state),
    })),
  } as TLibrary;
}
