import type {
  OpenPondExtensionCatalog,
  OpenPondProfileLibrary,
  OpenPondProfileRef,
  OpenPondProfileSkill,
  OpenPondProfileState,
} from "@openpond/contracts";

export type ComposerProfileTarget = {
  value: string;
  label: string;
  options: Array<{ value: string; label: string; detail: string }>;
};

export function openPondProfileRefKey(ref: OpenPondProfileRef): string {
  return JSON.stringify([ref.source, ref.repositoryId, ref.profileId]);
}

export function openPondProfileRefFromKey(
  library: OpenPondProfileLibrary,
  key: string,
): OpenPondProfileRef | null {
  return library.profiles.find((entry) => openPondProfileRefKey(entry.ref) === key)?.ref ?? null;
}

export function openPondProfileRefsEqual(
  left: OpenPondProfileRef | null | undefined,
  right: OpenPondProfileRef | null | undefined,
): boolean {
  return Boolean(
    left && right &&
      left.source === right.source &&
      left.repositoryId === right.repositoryId &&
      left.profileId === right.profileId,
  );
}

export function profileStateForRef(
  library: OpenPondProfileLibrary,
  ref: OpenPondProfileRef | null | undefined,
): OpenPondProfileState | null {
  return library.profiles.find((entry) => openPondProfileRefsEqual(entry.ref, ref))?.state ?? null;
}

export function composerProfileTargetForLibrary(
  library: OpenPondProfileLibrary | null | undefined,
  ref: OpenPondProfileRef | null | undefined,
): ComposerProfileTarget | null {
  if (!library || library.profiles.length <= 1) return null;
  const selectedEntry = library.profiles.find((entry) => openPondProfileRefsEqual(entry.ref, ref))
    ?? library.profiles.find((entry) => openPondProfileRefsEqual(entry.ref, library.lastUsed))
    ?? library.profiles[0];
  if (!selectedEntry) return null;
  return {
    value: openPondProfileRefKey(selectedEntry.ref),
    label: selectedEntry.name,
    options: library.profiles.map((entry) => ({
      value: openPondProfileRefKey(entry.ref),
      label: entry.name,
      detail: entry.ref.source === "local"
        ? entry.repoPath
        : `${entry.ref.source}: ${entry.ref.repositoryId}`,
    })),
  };
}

export function composerSkillsForProfile(
  profile: OpenPondProfileState | null | undefined,
  extensions: OpenPondExtensionCatalog | null | undefined,
): OpenPondProfileSkill[] {
  const skills = new Map((profile?.skills ?? []).map((skill) => [skill.name, skill]));
  for (const extension of extensions?.extensions ?? []) {
    if (extension.validationStatus !== "valid") continue;
    for (const skill of extension.skills) {
      if (skill.validationStatus !== "valid" || skills.has(skill.name)) continue;
      skills.set(skill.name, {
        name: skill.name,
        description: skill.description,
        path: skill.relativePath,
        scope: "profile",
        enabled: true,
        sourcePath: extension.sourcePath,
        charCount: skill.charCount,
        sourceHash: skill.sourceHash,
        validationStatus: "valid",
        validationMessages: [],
        resourceFiles: skill.resourceFiles,
      });
    }
  }
  return [...skills.values()].sort((left, right) => left.name.localeCompare(right.name));
}
