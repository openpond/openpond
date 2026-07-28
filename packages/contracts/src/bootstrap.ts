import { z } from "zod";
import { AccountStateSchema, CacheMetadataSchema, CodexStatusSchema } from "./account.js";
import { AppPreferencesSchema, PERSONALIZATION_TEMPLATES, PersonalizationSettingsSchema, ProviderSettingsSchema, ServerStatusSchema } from "./settings.js";
import { CloudProjectSchema, LocalProjectSchema, OpenPondAppSchema } from "./apps.js";
import { SidebarAppPreferencesSchema } from "./workspaces.js";
import { SessionSchema } from "./sessions.js";
import { RuntimeEventSchema } from "./runtime.js";
import { ApprovalSchema } from "./approvals.js";
import { PlaceholderPaneSchema } from "./placeholders.js";
import {
  OpenPondProfileLibrarySchema,
  OpenPondProfileStateSchema,
  emptyOpenPondProfileLibrary,
  emptyOpenPondProfileState,
} from "./profile.js";
import { SidebarFileBookmarkSchema } from "./sidebar-files.js";
import { CodexPersonalSkillSchema } from "./skills.js";
import { OpenPondExtensionCatalogSchema } from "./extensions.js";

export const BootstrapEventWindowSchema = z.object({
  latestSequence: z.number().int().nonnegative(),
  oldestSequence: z.number().int().nonnegative(),
  totalEvents: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative(),
  hasMoreBefore: z.boolean(),
});

export const BootstrapPayloadSchema = z.object({
  server: ServerStatusSchema,
  account: AccountStateSchema,
  codex: CodexStatusSchema,
  preferences: AppPreferencesSchema.optional().default(() => AppPreferencesSchema.parse({})),
  providers: ProviderSettingsSchema.optional().default(() => ProviderSettingsSchema.parse({})),
  personalization: PersonalizationSettingsSchema.optional().default(() =>
    PersonalizationSettingsSchema.parse({
      soul: PERSONALIZATION_TEMPLATES[0].content,
      soulPath: null,
      updatedAt: null,
    })
  ),
  apps: z.array(OpenPondAppSchema),
  localProjects: z.array(LocalProjectSchema).optional().default([]),
  cloudProjects: z.array(CloudProjectSchema).optional().default([]),
  profile: OpenPondProfileStateSchema.optional().default(emptyOpenPondProfileState),
  profileLibrary: OpenPondProfileLibrarySchema.optional().default(emptyOpenPondProfileLibrary),
  codexPersonalSkills: z.array(CodexPersonalSkillSchema).optional().default([]),
  extensionCatalog: OpenPondExtensionCatalogSchema.optional().default({
    rootPath: "",
    registryPath: "",
    extensions: [],
    error: null,
  }),
  codexHistorySessions: z.array(SessionSchema).optional().default([]),
  sidebarAppPreferences: SidebarAppPreferencesSchema,
  sidebarFileBookmarks: z.array(SidebarFileBookmarkSchema).optional().default([]),
  appsError: z.string().nullable(),
  appsMeta: CacheMetadataSchema,
  accountMeta: CacheMetadataSchema,
  sessions: z.array(SessionSchema),
  events: z.array(RuntimeEventSchema),
  eventWindow: BootstrapEventWindowSchema.optional(),
  approvals: z.array(ApprovalSchema),
  placeholders: z.array(PlaceholderPaneSchema),
  diagnostics: z.array(RuntimeEventSchema),
});

export type BootstrapPayload = z.infer<typeof BootstrapPayloadSchema>;
