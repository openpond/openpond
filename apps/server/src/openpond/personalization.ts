import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  DEFAULT_PERSONALIZATION_TEMPLATE_ID, PERSONALIZATION_TEMPLATES, PersonalizationSettingsSchema,
  type PersonalizationSettings, type PersonalizationTemplate, type UpdatePersonalizationRequest,
} from "@openpond/contracts";
import { readConfig, updateConfig, readOptionalFile, atomicWriteFile, withFileLock, storagePaths, PersistenceError, isMissing } from "@openpond/persistence";
import type { SqliteStore } from "../store/store.js";

const SOUL_MAX_CHARS = 8000;
function personalityPath(home: string, id: string): string {
  if (!/^custom:[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid custom personality identifier.");
  return path.join(storagePaths(home).instructions, "personalities", `${id.slice(7)}.md`);
}
function validateText(text: string, filePath?: string): string {
  if (text.length > SOUL_MAX_CHARS) throw new PersistenceError({ code: "INVALID_INSTRUCTIONS", path: filePath ?? "personalization", message: `Personality text exceeds ${SOUL_MAX_CHARS} characters.`, action: "Shorten the personality text before using it." });
  return text.trim();
}
async function templatesWithFiles(home: string): Promise<PersonalizationTemplate[]> {
  const directory = path.join(storagePaths(home).instructions, "personalities");
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error) => { if (isMissing(error)) return []; throw error; });
  const templates: PersonalizationTemplate[] = [...PERSONALIZATION_TEMPLATES];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !/^[a-zA-Z0-9_-]+\.md$/.test(entry.name)) continue;
    const filePath = path.join(directory, entry.name), content = await readOptionalFile(filePath);
    if (content === null) continue;
    templates.push({ id: `custom:${entry.name.slice(0, -3)}`, name: entry.name.slice(0, -3).replace(/[-_]+/g, " "), source: "custom", description: "", content: validateText(content, filePath) });
  }
  return templates;
}
export async function loadPersonalizationSettings(_store: SqliteStore, home: string): Promise<PersonalizationSettings> {
  const { document } = await readConfig(home), templates = await templatesWithFiles(home);
  const active = document.personalization?.active ?? `builtin:${DEFAULT_PERSONALIZATION_TEMPLATE_ID}`;
  const activeTemplateId = active.startsWith("builtin:") ? active.slice(8) : active;
  const template = templates.find((entry) => entry.id === activeTemplateId);
  if (!template) throw new PersistenceError({ code: "MISSING_PERSONALITY", path: active.startsWith("custom:") ? personalityPath(home, active) : storagePaths(home).config, message: `Selected personality ${active} is unavailable.`, action: "Restore its Markdown file or select an available personality in Settings." });
  const filePath = active.startsWith("custom:") ? personalityPath(home, active) : null;
  return PersonalizationSettingsSchema.parse({ activeTemplateId, customized: template.source === "custom", soul: document.personalization?.mode === "disabled" ? "" : template.content,
    soulPath: filePath, updatedAt: filePath ? (await fs.stat(filePath)).mtime.toISOString() : null, templates });
}
export async function savePersonalizationSettings(store: SqliteStore, home: string, input: UpdatePersonalizationRequest): Promise<PersonalizationSettings> {
  await withFileLock(path.join(storagePaths(home).runtime, "personalization"), async () => {
    const content = validateText(input.soul);
    const builtin = PERSONALIZATION_TEMPLATES.find((entry) => entry.id === input.activeTemplateId);
    let active: string;
    if (!input.saveAsNew && builtin && content === builtin.content.trim()) active = `builtin:${builtin.id}`;
    else {
      const slug = input.templateName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 56) || "custom";
      active = !input.saveAsNew && input.activeTemplateId.startsWith("custom:") ? input.activeTemplateId : `custom:${slug}-${randomUUID().slice(0, 8)}`;
      await atomicWriteFile(personalityPath(home, active), `${content}\n`);
    }
    await updateConfig(home, (document) => ({ ...document, personalization: { ...document.personalization, active } }));
  });
  return loadPersonalizationSettings(store, home);
}
export function buildPersonalizedSystemPrompt(soul: string, systemPrompt: string): string {
  return [validateText(soul), systemPrompt.trim()].filter(Boolean).join("\n\n");
}
