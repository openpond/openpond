import { z } from "zod";

export const RemoteAccessPeerSchema = z.object({
  id: z.string(),
  name: z.string(),
  dnsName: z.string().nullable(),
  os: z.string().nullable(),
  online: z.boolean(),
  active: z.boolean(),
  isSelf: z.boolean(),
  tailscaleIps: z.array(z.string()),
  lastSeen: z.string().nullable(),
});

export type RemoteAccessPeer = z.infer<typeof RemoteAccessPeerSchema>;

export const RemoteAccessTailscaleStateSchema = z.object({
  installed: z.boolean(),
  running: z.boolean(),
  version: z.string().nullable(),
  backendState: z.string().nullable(),
  tailnetName: z.string().nullable(),
  magicDnsSuffix: z.string().nullable(),
  machineName: z.string().nullable(),
  dnsName: z.string().nullable(),
  authUrl: z.string().nullable(),
  tailscaleIps: z.array(z.string()),
  health: z.array(z.string()),
  error: z.string().nullable(),
  peers: z.array(RemoteAccessPeerSchema),
});

export type RemoteAccessTailscaleState = z.infer<typeof RemoteAccessTailscaleStateSchema>;

export const RemoteAccessServeStateSchema = z.object({
  enabled: z.boolean(),
  reachable: z.boolean(),
  targetUrl: z.string().nullable(),
  httpsUrl: z.string().nullable(),
  httpsHost: z.string().nullable(),
  httpsPort: z.number().nullable(),
  setupUrl: z.string().nullable(),
  configText: z.string().nullable(),
  error: z.string().nullable(),
});

export type RemoteAccessServeState = z.infer<typeof RemoteAccessServeStateSchema>;

export const RemoteAccessStatusSchema = z.object({
  localUrl: z.string(),
  localWebUrl: z.string(),
  remoteUrl: z.string().nullable(),
  remoteWebUrl: z.string().nullable(),
  tokenHash: z.string(),
  tailscaleUpCommand: z.string(),
  serveCommand: z.string(),
  disableCommand: z.string(),
  operatorCommand: z.string(),
  webUiAvailable: z.boolean(),
  updatedAt: z.string(),
  tailscale: RemoteAccessTailscaleStateSchema,
  serve: RemoteAccessServeStateSchema,
});

export type RemoteAccessStatus = z.infer<typeof RemoteAccessStatusSchema>;

export const RemoteAccessToggleResponseSchema = z.object({
  message: z.string(),
  status: RemoteAccessStatusSchema,
});

export type RemoteAccessToggleResponse = z.infer<typeof RemoteAccessToggleResponseSchema>;
