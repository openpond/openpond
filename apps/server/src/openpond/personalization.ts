import { promises as fs } from "node:fs";
import path from "node:path";
import {
  DEFAULT_PERSONALIZATION_TEMPLATE_ID,
  PERSONALIZATION_TEMPLATES,
  PersonalizationSettingsSchema,
  type PersonalizationSettings,
  type PersonalizationTemplate,
  type PersonalizationTemplateId,
  type UpdatePersonalizationRequest,
} from "@openpond/contracts";
import { personalizationStatePath, soulPath, soulsDir } from "../paths.js";
import type { SqliteStore } from "../store/store.js";

const SOUL_MAX_CHARS = 8000;
const FILE_TEMPLATE_PREFIX = "file:";
const ACTIVE_TEMPLATE_CACHE_TYPE = "personalization";
const ACTIVE_TEMPLATE_CACHE_KEY = "active_template_id";
const BUILT_IN_TEMPLATE_IDS = new Set<string>(PERSONALIZATION_TEMPLATES.map((template) => template.id));

type PersonalizationState = {
  version: 1;
  activeTemplateId: string;
  updatedAt: string;
};

function trimSoul(content: string): string {
  return content.trim().slice(0, SOUL_MAX_CHARS);
}

function normalizeTemplateName(name: string): string {
  return name.trim().slice(0, 80) || "Custom";
}

function templateContent(templates: PersonalizationTemplate[], templateId: PersonalizationTemplateId): string {
  return templates.find((template) => template.id === templateId)?.content ?? PERSONALIZATION_TEMPLATES[0].content;
}

function slugify(name: string): string {
  return (
    normalizeTemplateName(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 56) || "custom"
  );
}

function titleFromFilename(filename: string): string {
  return filename
    .replace(/^soul-/i, "")
    .replace(/\.md$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function fileTemplateId(filename: string): string {
  return `${FILE_TEMPLATE_PREFIX}${filename}`;
}

function filenameFromTemplateId(templateId: string): string | null {
  if (!templateId.startsWith(FILE_TEMPLATE_PREFIX)) return null;
  const filename = templateId.slice(FILE_TEMPLATE_PREFIX.length);
  if (!filename || filename.includes("..") || path.isAbsolute(filename)) return null;
  return filename;
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    return null;
  }
}

async function readSoulFile(filePath: string): Promise<string | null> {
  try {
    const content = trimSoul(await fs.readFile(filePath, "utf8"));
    return content || null;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeSoulFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${trimSoul(content)}\n`, { mode: 0o600 });
}

async function readActiveTemplateId(store: SqliteStore, storeDir: string): Promise<string | null> {
  const cached = await store.getCacheEntry<string>(ACTIVE_TEMPLATE_CACHE_TYPE, ACTIVE_TEMPLATE_CACHE_KEY);
  if (typeof cached?.payload === "string" && cached.payload.trim()) return cached.payload;
  const state = await readJsonFile<PersonalizationState>(personalizationStatePath(storeDir));
  return typeof state?.activeTemplateId === "string" && state.activeTemplateId.trim() ? state.activeTemplateId : null;
}

async function writeActiveTemplateId(
  store: SqliteStore,
  storeDir: string,
  activeTemplateId: string
): Promise<PersonalizationState> {
  const state: PersonalizationState = {
    version: 1,
    activeTemplateId,
    updatedAt: new Date().toISOString(),
  };
  await store.setCacheEntry(ACTIVE_TEMPLATE_CACHE_TYPE, ACTIVE_TEMPLATE_CACHE_KEY, activeTemplateId);
  const filePath = personalizationStatePath(storeDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  return state;
}

async function listFileTemplates(storeDir: string): Promise<PersonalizationTemplate[]> {
  const entries = await fs.readdir(storeDir, { withFileTypes: true }).catch(() => []);
  const templates: PersonalizationTemplate[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^soul-.+\.md$/i.test(entry.name)) continue;
    const content = await readSoulFile(path.join(storeDir, entry.name));
    if (!content) continue;
    templates.push({
      id: fileTemplateId(entry.name),
      name: titleFromFilename(entry.name),
      source: "custom",
      description: "",
      content,
    });
  }

  const legacyDirectory = soulsDir(storeDir);
  const legacyEntries = await fs.readdir(legacyDirectory, { withFileTypes: true }).catch(() => []);
  for (const entry of legacyEntries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
    const content = await readSoulFile(path.join(legacyDirectory, entry.name));
    if (!content) continue;
    templates.push({
      id: fileTemplateId(`souls/${entry.name}`),
      name: titleFromFilename(entry.name),
      source: "custom",
      description: "",
      content,
    });
  }

  return templates.sort((left, right) => left.name.localeCompare(right.name));
}

async function templatesWithFiles(storeDir: string): Promise<PersonalizationTemplate[]> {
  return [...PERSONALIZATION_TEMPLATES, ...(await listFileTemplates(storeDir))];
}

async function uniqueSoulFilename(storeDir: string, name: string): Promise<string> {
  const directory = storeDir;
  await fs.mkdir(directory, { recursive: true });
  const base = slugify(name);
  let candidate = `soul-${base}.md`;
  for (let index = 2; ; index += 1) {
    try {
      await fs.access(path.join(directory, candidate));
      candidate = `soul-${base}-${index}.md`;
    } catch {
      return candidate;
    }
  }
}

async function saveFileTemplate(storeDir: string, templateId: string, name: string, content: string): Promise<string> {
  const existingFilename = filenameFromTemplateId(templateId);
  const filename = existingFilename ?? (await uniqueSoulFilename(storeDir, name));
  await writeSoulFile(path.join(storeDir, filename), content);
  return fileTemplateId(filename);
}

async function importActiveSoulFile(storeDir: string, templates: PersonalizationTemplate[]): Promise<string | null> {
  const activeSoul = await readSoulFile(soulPath(storeDir));
  if (!activeSoul) return null;
  const existing = templates.find((template) => template.content === activeSoul);
  if (existing) return existing.id;
  const filename = await uniqueSoulFilename(storeDir, "Imported SOUL");
  await writeSoulFile(path.join(storeDir, filename), activeSoul);
  return fileTemplateId(filename);
}

export async function loadPersonalizationSettings(
  store: SqliteStore,
  storeDir: string
): Promise<PersonalizationSettings> {
  let templates = await templatesWithFiles(storeDir);
  let activeTemplateId = (await readActiveTemplateId(store, storeDir)) ?? DEFAULT_PERSONALIZATION_TEMPLATE_ID;

  if (!templates.some((template) => template.id === activeTemplateId)) {
    const importedId = await importActiveSoulFile(storeDir, templates);
    if (importedId) {
      activeTemplateId = importedId;
      templates = await templatesWithFiles(storeDir);
    } else {
      activeTemplateId = DEFAULT_PERSONALIZATION_TEMPLATE_ID;
    }
  }

  const soul = templateContent(templates, activeTemplateId);
  await writeSoulFile(soulPath(storeDir), soul);
  const nextState = await writeActiveTemplateId(store, storeDir, activeTemplateId);

  return PersonalizationSettingsSchema.parse({
    activeTemplateId,
    customized: !BUILT_IN_TEMPLATE_IDS.has(activeTemplateId),
    soul,
    soulPath: soulPath(storeDir),
    updatedAt: nextState.updatedAt,
    templates,
  });
}

export async function savePersonalizationSettings(
  store: SqliteStore,
  storeDir: string,
  input: UpdatePersonalizationRequest
): Promise<PersonalizationSettings> {
  const soul = trimSoul(input.soul);
  const shouldCreateFile = input.saveAsNew;
  const activeTemplateId = shouldCreateFile
    ? await saveFileTemplate(storeDir, "", input.templateName, soul)
    : BUILT_IN_TEMPLATE_IDS.has(input.activeTemplateId)
      ? input.activeTemplateId
      : await saveFileTemplate(storeDir, input.activeTemplateId, input.templateName, soul);

  await writeSoulFile(soulPath(storeDir), soul);
  await writeActiveTemplateId(store, storeDir, activeTemplateId);
  return loadPersonalizationSettings(store, storeDir);
}

export function buildPersonalizedSystemPrompt(soul: string, systemPrompt: string): string {
  return [trimSoul(soul), systemPrompt.trim()].filter(Boolean).join("\n\n");
}
