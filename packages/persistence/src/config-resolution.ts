import { credentialVersions } from "./credentials.js";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { readConfig, mergeConfig } from "./config.js";
import { validateConfigDocument, type ConfigDocument } from "./config-schema.js";
import { configToPreferences, preferencesToConfig } from "./preference-config.js";
import { AppPreferencesSchema, PERSONALIZATION_TEMPLATES } from "./schemas/settings.js";
import { readOptionalFile } from "./private-file.js";
import { getLocalRecord, putLocalRecord } from "./database.js";
import { PersistenceError, isMissing, type PersistenceIssue } from "./errors.js";
import { resolveConfigPath } from "./home.js";

export type ConfigLayer = "defaults" | "profile" | "user" | "project" | "task" | "turn";
export type ConfigSource = { layer: ConfigLayer; path: string; revision: string };
export type EffectiveConfig = {
  document: ConfigDocument;
  effectiveRevision: string;
  sources: ConfigSource[];
  provenance: Record<string, ConfigSource>;
  diagnostics: PersistenceIssue[];
  credentialVersions: Record<string, string | null>;
  projectRoot: string | null;
  projectTrustRevision: number | null;
};
export type ConfigContext = {
  accountId?: string;
  projectRoot?: string | null;
  profile?: { id: string; revision: string; defaults: ConfigDocument };
  task?: ConfigDocument;
  turn?: ConfigDocument;
};
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex");
const trustKey = (root: string, accountId = "local"): string => hash([root, accountId]);

export async function setProjectTrust(home: string, projectRoot: string, accountId: string, trusted: boolean): Promise<void> {
  const root = await fs.realpath(projectRoot);
  putLocalRecord(home, "project_trust", trustKey(root, accountId), { root, accountId, trusted, updatedAt: new Date().toISOString() });
}

export async function resolveEffectiveConfig(home: string, context: ConfigContext = {}): Promise<EffectiveConfig> {
  let document = preferencesToConfig(AppPreferencesSchema.parse({}));
  const sources: ConfigSource[] = [], provenance: EffectiveConfig["provenance"] = {}, diagnostics: PersistenceIssue[] = [];
  function apply(layer: ConfigLayer, value: ConfigDocument, sourcePath: string, revision = hash(value)): void {
    const source = { layer, path: sourcePath, revision };
    document = mergeConfig(document, value);
    sources.push(source);
    function visit(value: unknown, segments: string[]): void {
      if (value && typeof value === "object" && !Array.isArray(value) && !("mode" in value) && !("source" in value) && !("provider_id" in value)) {
        for (const [key, entry] of Object.entries(value)) visit(entry, [...segments, key]);
      } else provenance[JSON.stringify(segments)] = source;
    }
    visit(value, []);
  }
  apply("defaults", document, "shipped");
  if (context.profile) {
    checkScope(context.profile.defaults, "profile");
    apply("profile", context.profile.defaults, context.profile.id, context.profile.revision);
  }
  const user = await readConfig(home);
  apply("user", user.document, user.path, user.rawRevision);
  let userBoundary = structuredClone(document.permissions);
  let projectRoot: string | null = null, projectTrustRevision: number | null = null;
  if (context.projectRoot) {
    projectRoot = await fs.realpath(context.projectRoot);
    const configPath = path.join(projectRoot, ".openpond", "config.toml");
    const stat = await fs.lstat(configPath).catch((error) => { if (isMissing(error)) return null; throw error; });
    if (stat) {
      const real = await fs.realpath(configPath);
      if (real !== configPath) throw new PersistenceError({ code: "UNSAFE_PROJECT_CONFIG", path: configPath, message: "Project configuration must be a regular file inside its canonical project root.", action: "Replace symbolic links in the project configuration path with a regular local file." });
      const trust = getLocalRecord<{ trusted: boolean }>(home, "project_trust", trustKey(projectRoot, context.accountId));
      if (!trust?.value.trusted) diagnostics.push({ code: "PROJECT_CONFIG_UNTRUSTED", path: configPath, message: "Project settings are ignored until this project is trusted.", action: "Review the project configuration, then trust it in configuration settings." });
      else {
        projectTrustRevision = trust.revision;
        const project = await readConfig(home, { path: configPath, scope: "project" });
        apply("project", project.document, project.path, project.rawRevision);
        if (userBoundary?.command_access === "disabled") document.permissions = { ...document.permissions, command_access: "disabled" };
        if (userBoundary?.codex_mode === "default") document.permissions = { ...document.permissions, codex_mode: "default" };
        userBoundary = structuredClone(document.permissions);
      }
    }
  }
  for (const layer of ["task", "turn"] as const) if (context[layer]) {
    checkScope(context[layer], layer);
    apply(layer, context[layer], layer);
  }
  // The host/user boundary is independent of lower-trust preference precedence.
  // Auto-review is incomparable with full access and cannot be acquired by an overlay.
  if (userBoundary?.command_access === "disabled" || userBoundary?.command_access === "ask" && document.permissions?.command_access === "full-access") document.permissions = { ...document.permissions, command_access: userBoundary.command_access };
  if (userBoundary?.codex_mode && userBoundary.codex_mode !== "full-access") {
    const requested = document.permissions?.codex_mode;
    if (requested !== "default") document.permissions = { ...document.permissions, codex_mode: userBoundary.codex_mode };
  }
  validateConfigDocument(document);
  await validateRequiredSources(home, document);
  const credentials = [...Object.values(document.accounts ?? {}), ...Object.values(document.providers ?? {})].flatMap((entry) => entry.credential?.source === "secret" ? [entry.credential.id] : []);
  const versions = await credentialVersions(home, credentials);
  return { document, effectiveRevision: hash({ document, sources, projectTrustRevision, versions }), sources, provenance, diagnostics, projectRoot, projectTrustRevision, credentialVersions: versions };
}

function checkScope(document: ConfigDocument, layer: "profile" | "task" | "turn"): void {
  validateConfigDocument(document);
  const allowed = layer === "profile" ? ["schema_version", "chat", "codex", "context_compaction", "subagents", "runtime"] : ["schema_version", "chat", "codex", "context_compaction", "subagents", "permissions"];
  for (const key of Object.keys(document)) if (!allowed.includes(key)) throw new PersistenceError({ code: "CONFIG_SCOPE_VIOLATION", path: `${layer}.${key}`, message: `This setting is not allowed in ${layer} configuration.`, action: "Move host settings to the user configuration file." });
}
async function validateRequiredSources(home: string, document: ConfigDocument): Promise<void> {
  const defaults = document.defaults;
  if (defaults?.account_id && (!document.accounts?.[defaults.account_id] || document.accounts[defaults.account_id].enabled === false)) throw new PersistenceError({ code: "INVALID_ACCOUNT_DEFAULT", path: "defaults.account_id", message: "The default account is missing or disabled.", action: "Choose an enabled account or remove the explicit default." });
  const active = document.personalization?.active;
  if (active && document.personalization?.mode !== "disabled") {
    const file = active.startsWith("custom:") ? path.join(home, "instructions", "personalities", `${active.slice(7)}.md`) : active;
    const text = active.startsWith("custom:") ? await readOptionalFile(file) : PERSONALIZATION_TEMPLATES.find((entry) => entry.id === active.slice(8))?.content;
    if (text == null || text.trim().length > 8000) throw new PersistenceError({ code: "MISSING_INSTRUCTION_SOURCE", path: file, message: "The selected personality is missing or exceeds its supported size.", action: "Restore its Markdown file or select an available personality in Settings." });
  }
  const required = document.personalization?.user_instructions;
  if (required) {
    const file = resolveConfigPath(required, home);
    try { const stat = await fs.stat(file); if (!stat.isFile()) throw new Error("Not a file"); await fs.access(file, fs.constants.R_OK); }
    catch (cause) { throw new PersistenceError({ code: "MISSING_INSTRUCTION_SOURCE", path: file, message: "The configured user instruction file cannot be read.", action: "Restore the file or remove its configuration reference." }, { cause }); }
  }
}
export async function captureConfigRun(home: string, runId: string, context: ConfigContext = {}): Promise<EffectiveConfig> {
  const snapshot = await resolveEffectiveConfig(home, context);
  putLocalRecord(home, "config_run_snapshots", runId, { ...snapshot, capturedAt: new Date().toISOString() }, null);
  return snapshot;
}
export async function assertConfigRunCurrent(home: string, snapshot: EffectiveConfig, context: ConfigContext = {}): Promise<void> {
  const current = await resolveEffectiveConfig(home, context);
  if (snapshot.projectTrustRevision !== null && current.projectTrustRevision !== snapshot.projectTrustRevision) throw new PersistenceError({ code: "PROJECT_TRUST_CHANGED", path: snapshot.projectRoot ?? home, message: "Project trust changed during this turn.", action: "Review project trust before starting a new turn." });
  const prior = snapshot.document.permissions, next = current.document.permissions;
  if (next?.command_access !== prior?.command_access || next?.codex_mode !== prior?.codex_mode || hash(current.credentialVersions) !== hash(snapshot.credentialVersions) || hash(current.document.accounts) !== hash(snapshot.document.accounts) || hash(current.document.providers) !== hash(snapshot.document.providers)) throw new PersistenceError({ code: "EXECUTION_POLICY_CHANGED", path: home, message: "Permissions or credential configuration changed during this turn.", action: "Start a new turn with the current settings." });
}
export function effectivePreferences(snapshot: EffectiveConfig): ReturnType<typeof configToPreferences> { return configToPreferences(snapshot.document); }
