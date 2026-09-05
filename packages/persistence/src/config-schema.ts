import { z } from "zod";
import { ProviderIdSchema } from "./schemas/providers.js";
import { CodexPermissionModeSchema, CodexReasoningEffortSchema, OpenPondCommandAccessModeSchema } from "./schemas/settings.js";
import { SubagentDelegationModeSchema, SubagentIsolationModeSchema, SubagentToolPolicySchema, SubagentPeerMessagesSchema, SubagentRoleIdSchema } from "./schemas/subagents.js";

const string = z.string().trim().min(1);
const pathString = z.string().trim().max(4096);
const identifier = string.max(200).refine((value) => !["__proto__", "prototype", "constructor"].includes(value), "Reserved identifier");
const model = z.strictObject({ provider_id: ProviderIdSchema, model_id: string.max(300) });
const inheritedModel = z.discriminatedUnion("mode", [z.strictObject({ mode: z.literal("inherit") }), z.strictObject({ mode: z.literal("custom"), ref: model })]);
export const CredentialReferenceSchema = z.discriminatedUnion("source", [
  z.strictObject({ source: z.literal("secret"), id: identifier }),
  z.strictObject({ source: z.literal("env"), name: string.regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(160) }),
]);
const account = z.strictObject({ handle: string, base_url: string.optional(), api_base_url: string.optional(), chat_api_base_url: string.optional(), environment: string.optional(), credential: CredentialReferenceSchema.optional(), enabled: z.boolean().optional() });
const provider = z.strictObject({ enabled: z.boolean().optional(), base_url: string.max(2048).optional(), default_model: string.max(300).optional(), model_overrides: z.array(string.max(300)).max(500).optional(), credential: CredentialReferenceSchema.optional() });
const language = z.strictObject({ mode: z.enum(["auto", "disabled", "custom"]).optional(), custom_command: pathString.optional() });
const cap = z.union([z.number().int().min(1).max(32), z.literal("unlimited")]);
const role = z.strictObject({
  enabled: z.boolean().optional(), model: inheritedModel.optional(), isolation_mode: SubagentIsolationModeSchema.optional(),
  max_concurrent_runs: z.number().int().min(1).max(16).optional(), tool_policy: SubagentToolPolicySchema.optional(),
  background: z.boolean().optional(), peer_messages: SubagentPeerMessagesSchema.optional(),
});
const profileRef = z.strictObject({ source: z.enum(["local", "github", "openpond_git"]), repository_id: string, profile_id: string });
export const ConfigSchema = z.strictObject({
  schema_version: z.literal(1),
  chat: z.strictObject({ model: model.optional(), steer_active_responses: z.boolean().optional() }).optional(),
  codex: z.strictObject({ reasoning_effort: CodexReasoningEffortSchema.optional() }).optional(),
  permissions: z.strictObject({ command_access: OpenPondCommandAccessModeSchema.optional(), codex_mode: CodexPermissionModeSchema.optional() }).optional(),
  context_compaction: z.strictObject({ auto_enabled: z.boolean().optional(), trigger_percent: z.number().int().min(50).max(95).optional(), summary_model: z.literal("same_model").optional() }).optional(),
  subagents: z.strictObject({
    enabled: z.boolean().optional(), delegation_mode: SubagentDelegationModeSchema.optional(), default_model: inheritedModel.optional(),
    max_concurrent_runs: z.number().int().min(1).max(32).optional(), max_concurrent_runs_per_provider: cap.optional(), max_concurrent_runs_per_workspace_target: cap.optional(),
    roles: z.record(SubagentRoleIdSchema, role).refine((value) => Object.keys(value).length <= 64, "At most 64 roles").optional(),
  }).optional(),
  projects: z.strictObject({ branch_prefix: z.string().trim().max(48).optional(), new_project_directory: pathString.optional() }).optional(),
  defaults: z.strictObject({ account_id: identifier.optional(), team_id: string.max(191).optional(), profile_ref: profileRef.optional() }).optional(),
  editor: z.strictObject({ language_servers: z.enum(["auto", "off"]).optional(), diagnostics_while_editing: z.boolean().optional(), check_on_save: z.boolean().optional(), languages: z.strictObject({ typescript: language.optional(), python: language.optional(), rust: language.optional() }).optional() }).optional(),
  training: z.strictObject({ default_model: inheritedModel.optional(), creation_mode: z.enum(["defaults", "customize"]).optional(), auto_approve_evidence: z.boolean().optional() }).optional(),
  ui: z.strictObject({ advanced_workspace_controls: z.boolean().optional() }).optional(),
  runtime: z.strictObject({ execution_mode: z.enum(["local", "hosted"]).optional(), mode: z.enum(["general", "builder"]).optional() }).optional(),
  personalization: z.strictObject({ active: string.regex(/^(builtin|custom):[a-zA-Z0-9_-]+$/).optional(), mode: z.enum(["enabled", "disabled"]).optional(), user_instructions: pathString.optional() }).optional(),
  storage: z.strictObject({ datasets_dir: pathString.optional() }).optional(),
  accounts: z.record(identifier, account).optional(),
  providers: z.record(identifier, provider).optional(),
});

export type ConfigDocument = z.infer<typeof ConfigSchema>;
export type ConfigModel = z.infer<typeof model>;
export type CredentialReference = z.infer<typeof CredentialReferenceSchema>;
export type ConfigScope = "user" | "project";
export type ConfigOperation = { op: "set"; path: string[]; value: unknown } | { op: "unset"; path: string[] };

export function validateConfigDocument(value: unknown, scope: ConfigScope = "user"): ConfigDocument {
  const config = ConfigSchema.parse(value);
  if (scope === "project") {
    const projectKeys = new Set(["schema_version", "chat", "codex", "permissions", "context_compaction", "subagents", "projects", "editor"]);
    for (const key of Object.keys(config)) if (!projectKeys.has(key)) throw new Error(`Setting ${key} is not permitted in project configuration.`);
    if (config.projects?.new_project_directory !== undefined) throw new Error("projects.new_project_directory is a user-only setting.");
    for (const entry of Object.values(config.editor?.languages ?? {})) if (entry.custom_command !== undefined) throw new Error("Custom editor commands must be configured in user settings.");
    if (config.permissions?.command_access === "full-access" || config.permissions?.codex_mode === "full-access" || config.permissions?.codex_mode === "auto-review") throw new Error("Project configuration can restrict permissions but cannot grant additional access.");
    for (const entry of Object.values(config.subagents?.roles ?? {})) if (entry.tool_policy && entry.tool_policy !== "read_only") throw new Error("Project roles cannot grant additional tool access.");
  }
  return config;
}
