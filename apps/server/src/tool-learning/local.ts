import { z } from "zod";
import { VERSION } from "../constants.js";
export const nativeToolLearningClientVersion = () => VERSION;
import { readCredential, writeCredential, resolveOpenPondHome } from "@openpond/persistence";
import {
  OpenPondToolLearningClient,
  ToolLearningRegistrationRequestSchema,
  ToolLearningInstallationSchema,
  ToolLearningIdSchema,
  ToolLearningEnvironmentSchema,
} from "openpond-sdk/tool-learning";

export type ToolLearningOptions = Record<string, string | boolean>;
const optionString = (options: ToolLearningOptions, key: string) =>
  typeof options[key] === "string" ? (options[key] as string).trim() : "";
export const ToolLearningCredentialRecordSchema = z
  .object({
    schemaVersion: z.literal("openpond.toolLearningLocalCredential.v1"),
    apiOrigin: z
      .string()
      .url()
      .refine((value) => new URL(value).origin === value),
    teamId: ToolLearningIdSchema,
    projectId: ToolLearningIdSchema,
    ownerAccount: z.string().nullable(),
    workspaceRoot: z.string().min(1),
    locallyEnabled: z.boolean(),
    environment: ToolLearningEnvironmentSchema.nullable().default(null),
    prepared: ToolLearningRegistrationRequestSchema,
    installation: ToolLearningInstallationSchema.nullable(),
  })
  .strict();
export type ToolLearningCredentialRecord = z.infer<typeof ToolLearningCredentialRecordSchema>;
export const toolLearningHome = (options: ToolLearningOptions) =>
  resolveOpenPondHome({ home: optionString(options, "home") || undefined });
export const toolLearningCredentialId = (id: string) =>
  `tool-learning:installation:${ToolLearningIdSchema.parse(id)}`;

export async function loadToolLearningCredential(home: string, id: string) {
  const stored = await readCredential<ToolLearningCredentialRecord>(
    home,
    toolLearningCredentialId(id),
  );
  if (!stored)
    throw new Error("Tool learning installation is not configured in this OpenPond home.");
  const value = ToolLearningCredentialRecordSchema.parse(stored.value);
  if (
    value.prepared.registration.installationId !== id ||
    value.prepared.registration.projectId !== value.projectId
  )
    throw new Error("Tool learning credential scope does not match its installation.");
  return { ...stored, value };
}
export async function saveToolLearningCredential(
  home: string,
  record: ToolLearningCredentialRecord,
  revision: number | null,
) {
  const parsed = ToolLearningCredentialRecordSchema.parse(record);
  return writeCredential(
    home,
    toolLearningCredentialId(parsed.prepared.registration.installationId),
    parsed,
    revision,
  );
}
export function toolLearningProducer(record: ToolLearningCredentialRecord) {
  return new OpenPondToolLearningClient({
    baseUrl: record.apiOrigin,
    apiKey: record.prepared.credential.apiKey,
    teamId: record.teamId,
    projectId: record.projectId,
  });
}
