import { randomUUID } from "node:crypto";
import {
  AppPreferencesSchema,
  PERSONALIZATION_TEMPLATES,
  type AppPreferences,
} from "@openpond/contracts";
import {
  HOST_STORAGE_CONTRACT_VERSION,
  type AgentHostStorageClient,
} from "@openpond/agent-runtime";
import { z } from "zod";

const ownerSettingsSchema = z.object({
  personalizationSoul: z.string().max(8_000).optional(),
  userInstructions: z.string().max(64_000).optional(),
  preferences: AppPreferencesSchema.optional(),
}).strict();
const storedSettingsSchema = z.object({
  revision: z.number().int().positive(),
  settings: ownerSettingsSchema,
}).strict();

export type HostedRuntimeSettings = {
  revision: number | null;
  personalizationSoul: string;
  userInstructions: string;
  preferences: AppPreferences;
};

/** An absent hosted record means documented built-in defaults, never local home settings. */
export async function loadHostedRuntimeSettings(client: AgentHostStorageClient): Promise<HostedRuntimeSettings> {
  const response = await client.request({
    contractVersion: HOST_STORAGE_CONTRACT_VERSION,
    requestId: randomUUID(),
    operation: "settings/get",
    params: {},
  });
  const stored = response === null ? null : storedSettingsSchema.parse(response);
  return {
    revision: stored?.revision ?? null,
    personalizationSoul: stored?.settings.personalizationSoul ?? PERSONALIZATION_TEMPLATES[0]!.content,
    userInstructions: stored?.settings.userInstructions ?? "",
    preferences: stored?.settings.preferences ?? AppPreferencesSchema.parse({}),
  };
}
