import { z } from "zod";
import {
  readOptionalFile, fileRevision, resolveEffectiveConfig, storagePaths,
  patchConfig, validateConfigText, replaceConfigText, persistenceIssue,
  configRecoveryRevisions, restoreConfigRevision, setProjectTrust, configEditorSchema,
  readClientChoices, updateClientChoices, ClientChoicesSchema,
} from "@openpond/persistence";

const operation = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("set"), path: z.array(z.string().min(1)).min(1), value: z.unknown() }),
  z.strictObject({ op: z.literal("unset"), path: z.array(z.string().min(1)).min(1) }),
]);
const requestSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("patch"), expectedRevision: z.string(), operations: z.array(operation).max(100) }),
  z.strictObject({ action: z.literal("replace"), expectedRevision: z.string(), text: z.string().max(1_048_576) }),
  z.strictObject({ action: z.literal("validate"), text: z.string().max(1_048_576) }),
  z.strictObject({ action: z.literal("restore"), expectedRevision: z.string(), revision: z.string() }),
  z.strictObject({ action: z.literal("trust"), root: z.string(), accountId: z.string(), trusted: z.boolean() }),
  z.strictObject({ action: z.literal("client-state"), owner: z.string(), patch: ClientChoicesSchema, importOnly: z.boolean().optional() }),
]);
export function createConfigurationPayloads(home: string) {
  let lastValid: Awaited<ReturnType<typeof resolveEffectiveConfig>> | null = null;
  async function status(projectRoot?: string, accountId?: string) {
    const file = storagePaths(home).config;
    let text: string | null = null, issue = null, effective = null;
    try {
      text = await readOptionalFile(file);
      effective = await resolveEffectiveConfig(home, { projectRoot, accountId });
      if (!projectRoot) lastValid = effective;
    } catch (error) { issue = persistenceIssue(error, file); }
    const retained = effective ?? (projectRoot ? null : lastValid);
    return {
      path: file, text, rawRevision: fileRevision(text), issue, effective: retained,
      usingLastValid: !effective && Boolean(retained), applies: "next_turn",
      recoverableRevisions: await configRecoveryRevisions(home),
      clientState: issue ? null : await readClientChoices(home),
    };
  }
  async function mutate(payload: unknown) {
    const input = requestSchema.parse(payload);
    if (input.action === "validate") return { valid: true, document: validateConfigText(input.text, storagePaths(home).config) };
    if (input.action === "patch") await patchConfig(home, input.expectedRevision, input.operations);
    if (input.action === "replace") await replaceConfigText(home, input.expectedRevision, input.text);
    if (input.action === "restore") await restoreConfigRevision(home, input.revision, input.expectedRevision);
    if (input.action === "trust") await setProjectTrust(home, input.root, input.accountId, input.trusted);
    if (input.action === "client-state") return updateClientChoices(home, input.owner, input.patch, input.importOnly);
    return status();
  }
  return { status, mutate, schema: configEditorSchema };
}
