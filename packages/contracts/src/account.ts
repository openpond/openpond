import { z } from "zod";

export const AccountProductSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    status: z.string(),
    isActive: z.boolean().nullable(),
    price: z.string().nullable(),
    currency: z.string().nullable(),
    credits: z.string().nullable(),
  })
  .passthrough();

export type AccountProduct = z.infer<typeof AccountProductSchema>;

export const AccountApiHealthSchema = z.object({
  reachable: z.boolean(),
  authenticated: z.boolean().nullable(),
  apiBase: z.string(),
  latencyMs: z.number(),
  status: z.number().nullable(),
  service: z.string().nullable(),
  checkedAt: z.string(),
  error: z.string().nullable(),
});

export type AccountApiHealth = z.infer<typeof AccountApiHealthSchema>;

export const AccountProfileSchema = z.object({
  id: z.string().nullable(),
  email: z.string().nullable(),
  name: z.string().nullable(),
  handle: z.string().nullable(),
  image: z.string().nullable(),
  timezone: z.string().nullable(),
  isAdmin: z.boolean().nullable(),
  isVerified: z.boolean().nullable(),
  dailyAgentAppId: z.string().nullable(),
  dailyAgentDeploymentId: z.string().nullable(),
  credits: z.string().nullable(),
});

export type AccountProfile = z.infer<typeof AccountProfileSchema>;

export const ActiveProfileSelectorSchema = z.object({
  handle: z.string(),
  baseUrl: z.string().nullable().optional(),
});

export type ActiveProfileSelector = z.infer<typeof ActiveProfileSelectorSchema>;

export const AccountStateSchema = z.object({
  state: z.enum(["signed_out", "signed_in", "loading", "switching", "auth_error"]),
  activeProfile: ActiveProfileSelectorSchema.nullable(),
  label: z.string(),
  email: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  environment: z.string().nullable(),
  baseUrl: z.string().nullable(),
  apiBaseUrl: z.string().nullable(),
  chatApiBaseUrl: z.string().nullable().optional().default(null),
  creditsLabel: z.string().nullable(),
  profile: AccountProfileSchema.nullable(),
  products: z.array(AccountProductSchema),
  apiHealth: AccountApiHealthSchema.nullable(),
  accounts: z.array(
    z.object({
      handle: z.string(),
      baseUrl: z.string().nullable(),
      apiBaseUrl: z.string().nullable().optional().default(null),
      chatApiBaseUrl: z.string().nullable().optional(),
      environment: z.string().nullable(),
      isActive: z.boolean(),
      authHealth: z.enum(["signed_out", "signed_in", "auth_error", "unknown"]),
      displayLabel: z.string().nullable(),
      email: z.string().nullable().optional().default(null),
      avatarUrl: z.string().nullable(),
    })
  ),
  error: z.string().nullable(),
});

export type AccountState = z.infer<typeof AccountStateSchema>;

export const CacheMetadataSchema = z.object({
  asOf: z.string().nullable(),
  refreshing: z.boolean(),
  lastRefreshError: z.string().nullable(),
  source: z.enum(["fresh", "cache", "empty"]),
});

export type CacheMetadata = z.infer<typeof CacheMetadataSchema>;

export const CodexStatusSchema = z.object({
  available: z.boolean(),
  binaryPath: z.string().nullable(),
  version: z.string().nullable(),
  authHealth: z.enum(["unknown", "signed_in", "signed_out", "auth_error"]),
  account: z
    .object({
      type: z.string(),
      email: z.string().nullable(),
      planType: z.string().nullable(),
      label: z.string().nullable(),
    })
    .nullable()
    .default(null),
  appServer: z.object({
    status: z.enum(["idle", "starting", "ready", "error"]),
    lastError: z.string().nullable(),
  }),
});

export type CodexStatus = z.infer<typeof CodexStatusSchema>;
