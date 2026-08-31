import {
  ModelProjectSchema,
  type BaseModelPreference,
  type ModelProject,
} from "@openpond/contracts";

export type ManagedRlBaseProfile = {
  baseProfileId: string;
  modelId: string;
  revision: string;
  tokenizerRevision: string;
  chatTemplateHash: string;
};

export const MANAGED_RL_BASE_PROFILE = {
  baseProfileId: "qwen3-8b-b968826d",
  modelId: "Qwen/Qwen3-8B",
  revision: "b968826d9c46dd6066d109eabc6255188de91218",
  tokenizerRevision: "b968826d9c46dd6066d109eabc6255188de91218",
  chatTemplateHash: "a55ee1b1660128b7098723e0abcd92caa0788061051c62d51cbe87d9cf1974d8",
} as const satisfies ManagedRlBaseProfile;

export function managedRlBaseProfileForModel(modelId: string): ManagedRlBaseProfile | null {
  return MANAGED_RL_BASE_PROFILE.modelId === modelId ? MANAGED_RL_BASE_PROFILE : null;
}

export function resolveManagedRlBaseProfile(
  preference: BaseModelPreference | null | undefined,
): ManagedRlBaseProfile | null {
  if (!preference) return null;
  const profile = MANAGED_RL_BASE_PROFILE;
  return preference.modelId === profile.modelId &&
    preference.revision === profile.revision &&
    preference.tokenizerRevision === profile.tokenizerRevision &&
    preference.chatTemplateHash === profile.chatTemplateHash
    ? profile
    : null;
}

export function versionModelProjectOntoManagedRlBase(
  project: ModelProject,
  updatedAt: string,
): ModelProject {
  const parsed = ModelProjectSchema.parse(project);
  const timestamp = new Date(updatedAt);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error("managed_rl_model_project_updated_at_invalid");
  }
  const baseModel = {
    schemaVersion: "openpond.baseModelPreference.v1" as const,
    modelId: MANAGED_RL_BASE_PROFILE.modelId,
    revision: MANAGED_RL_BASE_PROFILE.revision,
    tokenizerRevision: MANAGED_RL_BASE_PROFILE.tokenizerRevision,
    chatTemplateHash: MANAGED_RL_BASE_PROFILE.chatTemplateHash,
    modelAssetId: null,
    source: "managed" as const,
  };
  if (
    resolveManagedRlBaseProfile(parsed.trainingSetup.baseModel) &&
    resolveManagedRlBaseProfile(parsed.defaultBaseModel)
  ) {
    return parsed;
  }
  return ModelProjectSchema.parse({
    ...parsed,
    revision: parsed.revision + 1,
    defaultBaseModel: baseModel,
    trainingSetup: { ...parsed.trainingSetup, baseModel },
    updatedAt: timestamp.toISOString(),
  });
}
