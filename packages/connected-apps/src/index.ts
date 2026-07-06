export type ConnectedAppKind = "native" | "oauth" | "mcp";

export type ConnectedAppId =
  | "slack"
  | "microsoft_teams"
  | "github"
  | "google"
  | "x"
  | "mcp";

export type ConnectedAppProviderFamilyId =
  | "slack"
  | "microsoft_teams"
  | "github"
  | "google"
  | "x"
  | "mcp";

export type ConnectedAppSetupSurface =
  | "native_bot"
  | "oauth_connector"
  | "mcp_endpoint";

export type ConnectedAppStatusSource =
  | "integration_connection"
  | "native_binding"
  | "mcp_endpoint";

export type ConnectedAppCapabilityAccess =
  | "read"
  | "write"
  | "setup"
  | "tooling";

export type ConnectedAppCapability = {
  id: string;
  label: string;
  description: string;
  access: ConnectedAppCapabilityAccess;
  leaseable: boolean;
};

export type ConnectedAppSkillDescriptor = {
  name: string;
  description: string;
  path: string;
};

export type ConnectedAppIntegrationSkill = ConnectedAppSkillDescriptor & {
  provider: ConnectedAppProviderFamilyId;
  body: string;
  sourceHash: string;
  charCount: number;
};

export type ConnectedAppToolDescriptor = {
  name: string;
  description: string;
  capabilityIds: string[];
  write: boolean;
};

export type ConnectedAppProviderOperationInputSpec = {
  requiredKeys: string[];
};

export type ConnectedAppProviderOperationDescriptor = {
  id: string;
  operation: ConnectedAppProviderToolOperation;
  label: string;
  description: string;
  capabilityIds: string[];
  input?: ConnectedAppProviderOperationInputSpec;
  requiresReadback: boolean;
  requiresRuntimeLease: boolean;
};

export const CONNECTED_APP_PROVIDER_TOOL_NAMES = [
  "connected_app_search",
  "connected_app_read",
  "connected_app_write",
] as const;

export type ConnectedAppProviderToolName = typeof CONNECTED_APP_PROVIDER_TOOL_NAMES[number];
export type ConnectedAppProviderToolOperation = "search" | "read" | "write";

export const CONNECTED_APP_TOOL_CALL_ENDPOINT = "/v1/integrations/tool-calls";

export type ConnectedAppToolCallRequest = {
  provider: ConnectedAppProviderFamilyId;
  operation: ConnectedAppProviderToolOperation;
  toolName: ConnectedAppProviderToolName;
  sessionId: string;
  turnId: string;
  userPrompt: string;
  connectionIds: string[];
  capabilityIds: string[];
  args: Record<string, unknown>;
};

export type ConnectedAppToolCallResponse = {
  ok: boolean;
  output?: string | null;
  data?: unknown;
};

export type ConnectedAppToolCallValidationResult =
  | { ok: true; request: ConnectedAppToolCallRequest }
  | { ok: false; error: string };

export type ConnectedAppLeasePolicy = {
  leaseable: boolean;
  defaultTtlSeconds: number | null;
  allowedCapabilityIds: string[];
  requiresProxy: boolean;
};

export type ConnectedAppCatalogEntry = {
  id: ConnectedAppId;
  providerFamily: ConnectedAppProviderFamilyId;
  setupSurface: ConnectedAppSetupSurface;
  statusSource: ConnectedAppStatusSource;
  label: string;
  shortLabel: string;
  kind: ConnectedAppKind;
  category: string;
  description: string;
  icon: string;
  deepLinkAppId?: string;
  installLabel: string;
};

export type ConnectedAppBundle = {
  id: ConnectedAppProviderFamilyId;
  label: string;
  shortLabel: string;
  category: string;
  icon: string;
  description: string;
  setupSurfaces: ConnectedAppCatalogEntry[];
  capabilities: ConnectedAppCapability[];
  skills: ConnectedAppSkillDescriptor[];
  tools: ConnectedAppToolDescriptor[];
  operations: ConnectedAppProviderOperationDescriptor[];
  leasePolicy: ConnectedAppLeasePolicy;
};

export type ConnectedAppConnectionLike = {
  id?: string | null;
  teamId?: string | null;
  provider?: string | null;
  providerAccountName?: string | null;
  providerWorkspaceName?: string | null;
  scopes?: string[] | null;
  capabilities?: string[] | null;
  status?: string | null;
};

export type ConnectedAppStatusConnection = {
  id: string | null;
  teamId: string | null;
  provider: ConnectedAppProviderFamilyId;
  accountLabel: string | null;
  workspaceLabel: string | null;
  scopes: string[];
  capabilities: string[];
  status: string;
};

export type ConnectedAppSurfaceState =
  | "connected"
  | "disconnected"
  | "setup_available";

export type ConnectedAppStatusRow = ConnectedAppCatalogEntry & {
  providerLabel: string;
  setupSurfaceLabel: string;
  status: ConnectedAppSurfaceState;
  statusLabel: string;
  connections: ConnectedAppStatusConnection[];
  connected: boolean;
  capabilities: ConnectedAppCapability[];
  capabilityLabels: string[];
  leasePolicy: ConnectedAppLeasePolicy;
};

export type ConnectedAppStatusResponse<Account = unknown> = {
  teamId: string | null;
  apps: ConnectedAppStatusRow[];
  account?: Account;
};

export const DEFAULT_OPENPOND_WEB_BASE_URL = "https://openpond.ai";

export const CONNECTED_APP_PROVIDER_ORDER: ConnectedAppProviderFamilyId[] = [
  "slack",
  "google",
  "github",
  "x",
  "microsoft_teams",
  "mcp",
];

const CAPABILITIES = {
  slack: [
    capability("slack.channel.bind", "Bind channels", "Bind Slack channels or threads to OpenPond profiles.", "setup", false),
    capability("slack.message.ingest", "Ingest messages", "Ingest Slack channel or thread activity into OpenPond context.", "setup", false),
  ],
  microsoft_teams: [
    capability("microsoft_teams.channel.bind", "Bind channels", "Bind Teams channels or chats to OpenPond profiles.", "setup", false),
    capability("microsoft_teams.message.ingest", "Ingest messages", "Ingest Teams channel or chat activity into OpenPond context.", "setup", false),
  ],
  google: [
    capability("google.drive.file.read", "Read Drive files", "Find and read Google Drive files.", "read", true),
    capability("google.drive.file.write", "Write Drive files", "Create or update approved Google Drive files.", "write", true),
    capability("google.docs.read", "Read Docs", "Read Google Docs content and structure.", "read", true),
    capability("google.docs.write", "Edit Docs", "Apply approved Google Docs edits.", "write", true),
    capability("google.comments.read", "Read comments", "Read Google file comments.", "read", true),
    capability("google.comments.write", "Write comments", "Create or resolve approved Google comments.", "write", true),
  ],
  github: [
    capability("github.repo.read", "Read repositories", "Read repository metadata and file context.", "read", true),
    capability("github.issue.read", "Read issues", "Read GitHub issues and comments.", "read", true),
    capability("github.issue.write", "Update issues", "Create or update approved GitHub issue content.", "write", true),
    capability("github.pull_request.read", "Read pull requests", "Read pull request metadata, diffs, checks, and reviews.", "read", true),
    capability("github.pull_request.write", "Update pull requests", "Create approved comments or pull request updates.", "write", true),
  ],
  x: [
    capability("x.profile.read", "Read profile", "Read the connected X profile.", "read", true),
    capability("x.search.read", "Search X", "Search public X posts when granted.", "read", true),
    capability("x.mentions.read", "Read mentions", "Read mentions for the connected X account.", "read", true),
    capability("x.post.write", "Post", "Create approved X posts.", "write", true),
    capability("x.reply.write", "Reply", "Create approved X replies.", "write", true),
  ],
  mcp: [
    capability("mcp.tool.discover", "Discover tools", "Discover team-scoped MCP tools.", "tooling", false),
    capability("mcp.tool.call", "Call tools", "Call approved MCP tools through the team endpoint.", "tooling", false),
  ],
} satisfies Record<ConnectedAppProviderFamilyId, ConnectedAppCapability[]>;

const PROVIDER_OPERATIONS = {
  slack: [],
  microsoft_teams: [],
  google: [
    providerOperation("google.drive.search", "search", "Search Drive", "Search Google Drive files by grounded query.", ["google.drive.file.read"]),
    providerOperation("google.drive.read_file", "read", "Read Drive file", "Read Drive file metadata or exported content by stable ref.", ["google.drive.file.read"], { requiredKeys: ["ref"] }),
    providerOperation("google.docs.read", "read", "Read Google Doc", "Read Google Docs content and structure by stable ref.", ["google.docs.read"], { requiredKeys: ["ref"] }),
    providerOperation("google.comments.read", "read", "Read comments", "Read comments for a grounded Google file ref.", ["google.comments.read"], { requiredKeys: ["ref"] }),
    providerOperation("google.docs.update", "write", "Update Google Doc", "Apply an explicitly approved Google Docs edit and return readback verification.", ["google.docs.write"], { requiredKeys: ["ref", "patch"] }),
    providerOperation("google.comments.create", "write", "Create comment", "Create an explicitly approved Google file comment and return readback verification.", ["google.comments.write"], { requiredKeys: ["ref", "body"] }),
    providerOperation("google.comments.resolve", "write", "Resolve comment", "Resolve an explicitly approved Google comment and return readback verification.", ["google.comments.write"], { requiredKeys: ["ref", "commentId"] }),
  ],
  github: [
    providerOperation("github.repo.search", "search", "Search repositories", "Search accessible repositories by owner, name, or topic.", ["github.repo.read"]),
    providerOperation("github.issue.search", "search", "Search issues", "Search accessible GitHub issues.", ["github.issue.read"]),
    providerOperation("github.pull_request.search", "search", "Search pull requests", "Search accessible GitHub pull requests.", ["github.pull_request.read"]),
    providerOperation("github.repo.read", "read", "Read repository", "Read grounded repository metadata or file context.", ["github.repo.read"], { requiredKeys: ["ref"] }),
    providerOperation("github.issue.read", "read", "Read issue", "Read a grounded GitHub issue and comments.", ["github.issue.read"], { requiredKeys: ["ref"] }),
    providerOperation("github.pull_request.read", "read", "Read pull request", "Read a grounded pull request, checks, reviews, or diff summary.", ["github.pull_request.read"], { requiredKeys: ["ref"] }),
    providerOperation("github.issue.comment", "write", "Comment on issue", "Create an explicitly approved GitHub issue comment and return readback verification.", ["github.issue.write"], { requiredKeys: ["ref", "body"] }),
    providerOperation("github.issue.update", "write", "Update issue", "Apply an explicitly approved issue metadata/content update and return readback verification.", ["github.issue.write"], { requiredKeys: ["ref"] }),
    providerOperation("github.pull_request.comment", "write", "Comment on pull request", "Create an explicitly approved pull request comment and return readback verification.", ["github.pull_request.write"], { requiredKeys: ["ref", "body"] }),
    providerOperation("github.pull_request.update", "write", "Update pull request", "Apply an explicitly approved pull request metadata update and return readback verification.", ["github.pull_request.write"], { requiredKeys: ["ref"] }),
  ],
  x: [
    providerOperation("x.profile.read", "read", "Read profile", "Read the connected X account profile.", ["x.profile.read"]),
    providerOperation("x.post.read", "read", "Read post", "Read a public X post by stable ref, status URL, or post id.", ["x.search.read"], { requiredKeys: ["ref"] }),
    providerOperation("x.search.posts", "search", "Search recent posts", "Search public X posts from the X recent-search window by grounded query.", ["x.search.read"]),
    providerOperation("x.mentions.search", "search", "Search mentions", "Search mentions for the connected X account.", ["x.mentions.read"]),
    providerOperation("x.mention.read", "read", "Read mention", "Read a grounded mention or post ref.", ["x.mentions.read"], { requiredKeys: ["ref"] }),
    providerOperation("x.post.create", "write", "Create post", "Create an explicitly approved X post and return readback verification.", ["x.post.write"], { requiredKeys: ["text"] }),
    providerOperation("x.reply.create", "write", "Create reply", "Create an explicitly approved X reply and return readback verification.", ["x.reply.write"], { requiredKeys: ["inReplyToRef", "text"] }),
  ],
  mcp: [],
} satisfies Record<ConnectedAppProviderFamilyId, ConnectedAppProviderOperationDescriptor[]>;

const INTEGRATION_SKILL_BODIES = {
  google: [
    "# Google Connected App",
    "",
    "Use Google only through server-provided connected app tools. Never ask for or infer OAuth tokens.",
    "Before reading or editing, identify the exact Drive file, Doc, Sheet, Slide, or comment thread. If the target is ambiguous, ask a short clarification or search first.",
    "Use only declared Google operation ids: google.drive.search, google.drive.read_file, google.docs.read, google.comments.read, google.docs.update, google.comments.create, google.comments.resolve.",
    "For writes, require explicit user intent, summarize the planned change, and verify the target identity before applying updates.",
    "After a write, read back the changed object or relevant range and report the result with the provider file name or stable reference.",
    "Prefer narrow reads over broad Drive scans. Do not expose private file ids unless the tool result already presents them as stable refs.",
  ].join("\n"),
  github: [
    "# GitHub Connected App",
    "",
    "Use GitHub only through server-provided connected app tools. Repository, issue, and pull request identity must be grounded before action.",
    "Use only declared GitHub operation ids: github.repo.search, github.issue.search, github.pull_request.search, github.repo.read, github.issue.read, github.pull_request.read, github.issue.comment, github.issue.update, github.pull_request.comment, github.pull_request.update.",
    "For reads, name the owner/repo and issue or pull request number when available. If several targets match, ask or inspect before proceeding.",
    "For writes, require explicit user intent and avoid destructive repository changes. Prefer comments, labels, or metadata updates unless a stronger operation is clearly requested.",
    "Do not claim CI, review, branch, or PR state changed until a tool result confirms it.",
    "Keep local workspace git operations separate from connected GitHub operations unless the user explicitly asks to bridge them.",
  ].join("\n"),
  x: [
    "# X Connected App",
    "",
    "Use X only through server-provided connected app tools. Distinguish profile, recent search, mention, post, and reply operations.",
    "Use only declared X operation ids: x.profile.read, x.post.read, x.search.posts, x.mentions.search, x.mention.read, x.post.create, x.reply.create.",
    "For x.com, twitter.com, or stable status URLs, first parse the status/post id and read the post with connected_app_read using operation x.post.read and ref set to the original URL, stable ref, or id. Do not open a browser before trying the X connector.",
    "Use x.search.posts for discovery, related public posts, replies, quote-post searches, and conversation scans. It uses X API recent search, so report zero-result searches as zero recent public posts returned by X.",
    "For conversation or reply collection, dedupe by returned post id/ref. Do not repeat the same search call unless the result exposes a usable cursor or next token; if pagination is unavailable, state that coverage is limited to returned recent-search results.",
    "Reads can summarize recent public posts, connected-account profile details, and mentions when the capability is available.",
    "Writes require explicit user intent for the exact post or reply. Do not publish drafts, jokes, endorsements, or replies unless the user clearly approves the content.",
    "Before posting or replying, preserve account identity, quote the proposed content in summary form, and respect provider limits and policy boundaries.",
    "After a write, verify the returned post or reply ref before reporting success.",
  ].join("\n"),
  microsoft_teams: [
    "# Microsoft Teams Connected App",
    "",
    "Microsoft Teams is currently an ingestion/native binding surface only. Do not expose Teams OAuth reads, replies, file operations, or sandbox leases.",
    "Native Teams setup can bind chats or channels to OpenPond profiles and ingest activity into OpenPond context.",
    "If the user asks for Teams actions beyond ingestion or binding status, explain that the connector is not available yet rather than inventing tool access.",
  ].join("\n"),
  slack: [
    "# Slack Connected App",
    "",
    "Slack is currently an ingestion/native binding surface only. Do not expose Slack OAuth reads, replies, file operations, or sandbox leases.",
    "Native Slack setup can bind channels or threads to OpenPond profiles and ingest activity into OpenPond context.",
    "If the user asks for Slack actions beyond ingestion or binding status, explain that the connector is not available yet rather than inventing tool access.",
  ].join("\n"),
  mcp: [
    "# OpenPond MCP Connected App",
    "",
    "Use OpenPond MCP only through server-provided tool discovery and call paths. Do not invent MCP tools or endpoints.",
    "Treat MCP as team-scoped tooling, not an OAuth connector. Tool availability must come from server-confirmed discovery results.",
    "Before calling an MCP tool, match the requested operation to the tool name, description, input schema, and allowed team context.",
    "For writes or side effects, require explicit user intent and report only confirmed tool results.",
  ].join("\n"),
} satisfies Record<ConnectedAppProviderFamilyId, string>;

export const CONNECTED_APP_INTEGRATION_SKILLS: ConnectedAppIntegrationSkill[] =
  CONNECTED_APP_PROVIDER_ORDER.map((provider) => {
    const descriptor = integrationSkillDescriptor(provider);
    const body = INTEGRATION_SKILL_BODIES[provider];
    return {
      ...descriptor,
      provider,
      body,
      sourceHash: `connected-app-skill:${provider}:${hashString(body)}`,
      charCount: body.length,
    };
  });

export function connectedAppIntegrationSkillByProvider(
  provider: string | null | undefined,
): ConnectedAppIntegrationSkill | null {
  const normalized = normalizeConnectedAppProviderFamilyId(provider);
  if (!normalized) return null;
  return CONNECTED_APP_INTEGRATION_SKILLS.find((skill) => skill.provider === normalized) ?? null;
}

export function connectedAppIntegrationSkillByName(
  name: string | null | undefined,
): ConnectedAppIntegrationSkill | null {
  const normalized = name?.trim();
  if (!normalized) return null;
  return CONNECTED_APP_INTEGRATION_SKILLS.find((skill) => skill.name === normalized) ?? null;
}

export function validateConnectedAppToolCallRequest(
  request: ConnectedAppToolCallRequest,
): ConnectedAppToolCallValidationResult {
  const bundle = connectedAppBundleByProvider(request.provider);
  if (!bundle) {
    return { ok: false, error: `Connected app provider is not supported: ${request.provider}` };
  }
  if (!bundle.leasePolicy.leaseable) {
    return {
      ok: false,
      error: `Connected app provider ${request.provider} is not leaseable for cloud connector execution.`,
    };
  }

  const expectedToolName = toolNameForOperation(request.operation);
  if (request.toolName !== expectedToolName) {
    return {
      ok: false,
      error: `Connected app tool ${request.toolName} does not match ${request.operation} operation.`,
    };
  }

  const access = request.operation === "write" ? "write" : "read";
  const allowedCapabilityIds = new Set(
    bundle.capabilities
      .filter((capability) => capability.access === access && capability.leaseable)
      .map((capability) => capability.id),
  );
  const unauthorized = request.capabilityIds.filter((capabilityId) => !allowedCapabilityIds.has(capabilityId));
  if (unauthorized.length > 0) {
    return {
      ok: false,
      error: `Connected app capability ${unauthorized[0]} is not allowed for ${request.provider} ${request.operation}.`,
    };
  }

  const operationValidation = validateConnectedAppProviderOperationRequest(request);
  if (!operationValidation.ok) return operationValidation;

  return { ok: true, request };
}

export function connectedAppProviderOperations(
  provider: string | null | undefined,
): ConnectedAppProviderOperationDescriptor[] {
  const normalized = normalizeConnectedAppProviderFamilyId(provider);
  return normalized ? PROVIDER_OPERATIONS[normalized] : [];
}

export function connectedAppProviderOperationById(
  provider: string | null | undefined,
  operationId: string | null | undefined,
): ConnectedAppProviderOperationDescriptor | null {
  const normalizedId = normalizeProviderOperationId(operationId);
  if (!normalizedId) return null;
  return connectedAppProviderOperations(provider).find((operation) => operation.id === normalizedId) ?? null;
}

export function validateConnectedAppProviderOperationRequest(
  request: Pick<ConnectedAppToolCallRequest, "provider" | "operation" | "capabilityIds" | "args">,
): ConnectedAppToolCallValidationResult {
  const requestedOperation = providerOperationIdFromArgs(request.args);
  const operations = connectedAppProviderOperations(request.provider).filter(
    (operation) => operation.operation === request.operation,
  );
  if (operations.length === 0) {
    return {
      ok: false,
      error: `Connected app provider ${request.provider} does not declare ${request.operation} operations.`,
    };
  }
  if (!requestedOperation) {
    if (request.operation === "write") {
      return {
        ok: false,
        error: `Connected app ${request.provider} write calls require a provider operation id.`,
      };
    }
    return { ok: true, request: request as ConnectedAppToolCallRequest };
  }
  const operation = operations.find((candidate) => candidate.id === requestedOperation);
  if (!operation) {
    return {
      ok: false,
      error: `Connected app operation ${requestedOperation} is not allowed for ${request.provider} ${request.operation}.`,
    };
  }
  const deniedCapabilities = request.capabilityIds.filter((capabilityId) =>
    !operation.capabilityIds.includes(capabilityId),
  );
  if (deniedCapabilities.length > 0) {
    return {
      ok: false,
      error: `Connected app operation ${operation.id} does not allow capability ${deniedCapabilities[0]}.`,
    };
  }
  const input = providerOperationInputFromArgs(request.args, request.operation);
  for (const key of operation.input?.requiredKeys ?? []) {
    const value = input[key];
    if (value === undefined || value === null || (typeof value === "string" && !value.trim())) {
      return {
        ok: false,
        error: `Connected app operation ${operation.id} requires input.${key}.`,
      };
    }
  }
  return { ok: true, request: request as ConnectedAppToolCallRequest };
}

const CATALOG = [
  catalogEntry({
    id: "slack",
    providerFamily: "slack",
    setupSurface: "native_bot",
    statusSource: "native_binding",
    label: "Slack",
    shortLabel: "Slack",
    kind: "native",
    category: "Chat",
    description: "Bind Slack channels or threads for ingestion into OpenPond profiles.",
    icon: "/connected-apps/slack.svg",
    installLabel: "Continue to Slack details",
  }),
  catalogEntry({
    id: "google",
    providerFamily: "google",
    setupSurface: "oauth_connector",
    statusSource: "integration_connection",
    label: "Google",
    shortLabel: "Google",
    kind: "oauth",
    category: "Productivity",
    description: "Docs, Drive files, and comments for sandbox workflows.",
    icon: "/connected-apps/google.svg",
    installLabel: "Continue to Google details",
  }),
  catalogEntry({
    id: "github",
    providerFamily: "github",
    setupSurface: "oauth_connector",
    statusSource: "integration_connection",
    label: "GitHub",
    shortLabel: "GitHub",
    kind: "oauth",
    category: "Developer tools",
    description: "Access repositories, issues, and pull requests.",
    icon: "/connected-apps/github.svg",
    installLabel: "Continue to GitHub details",
  }),
  catalogEntry({
    id: "x",
    providerFamily: "x",
    setupSurface: "oauth_connector",
    statusSource: "integration_connection",
    label: "X",
    shortLabel: "X",
    kind: "oauth",
    category: "Productivity",
    description: "User profile, mentions, and approved reply access.",
    icon: "/connected-apps/x.svg",
    installLabel: "Continue to X details",
  }),
  catalogEntry({
    id: "microsoft_teams",
    providerFamily: "microsoft_teams",
    setupSurface: "native_bot",
    statusSource: "native_binding",
    label: "Teams",
    shortLabel: "Teams",
    kind: "native",
    category: "Chat",
    description: "Bind Teams chats or channels for ingestion into OpenPond profiles.",
    icon: "/connected-apps/microsoft.svg",
    installLabel: "Continue to Teams details",
  }),
  catalogEntry({
    id: "mcp",
    providerFamily: "mcp",
    setupSurface: "mcp_endpoint",
    statusSource: "mcp_endpoint",
    label: "OpenPond MCP",
    shortLabel: "MCP",
    kind: "mcp",
    category: "Tools",
    description: "Expose workspace tools through a team-scoped MCP endpoint.",
    icon: "/connected-apps/openpond-mcp.svg",
    installLabel: "Open MCP settings",
  }),
] satisfies ConnectedAppCatalogEntry[];

export const CONNECTED_APP_CATALOG: ConnectedAppCatalogEntry[] = CATALOG;

export const CONNECTED_APP_BUNDLES: ConnectedAppBundle[] =
  CONNECTED_APP_PROVIDER_ORDER.map((providerFamily) => {
    const setupSurfaces = CONNECTED_APP_CATALOG.filter(
      (entry) => entry.providerFamily === providerFamily,
    );
    const firstSurface = setupSurfaces[0]!;
    return {
      id: providerFamily,
      label: providerFamilyLabel(providerFamily),
      shortLabel: firstSurface.shortLabel,
      category: firstSurface.category,
      icon: firstSurface.icon,
      description: firstSurface.description,
      setupSurfaces,
      capabilities: CAPABILITIES[providerFamily],
      skills: providerSkills(providerFamily),
      tools: providerTools(providerFamily),
      operations: PROVIDER_OPERATIONS[providerFamily],
      leasePolicy: leasePolicy(providerFamily),
    };
  });

export function connectedAppById(
  appId: string | null | undefined,
): ConnectedAppCatalogEntry | null {
  const normalized = normalizeConnectedAppId(appId);
  if (!normalized) return null;
  return CONNECTED_APP_CATALOG.find((app) => app.id === normalized) ?? null;
}

export function connectedAppBundleByProvider(
  provider: string | null | undefined,
): ConnectedAppBundle | null {
  const normalized = normalizeConnectedAppProviderFamilyId(provider);
  if (!normalized) return null;
  return CONNECTED_APP_BUNDLES.find((bundle) => bundle.id === normalized) ?? null;
}

export function connectedAppBundleForCatalogId(
  appId: string | null | undefined,
): ConnectedAppBundle | null {
  const app = connectedAppById(appId);
  return app ? connectedAppBundleByProvider(app.providerFamily) : null;
}

export function buildConnectedAppInstallUrl(input: {
  appId: ConnectedAppId;
  baseUrl?: string | null;
  teamId?: string | null;
}): string {
  const app = connectedAppById(input.appId);
  const baseUrl = normalizeOpenPondWebBaseUrl(input.baseUrl);
  const path = app?.kind === "mcp" ? "/sandboxes/mcp" : "/sandboxes/apps";
  const url = new URL(path, baseUrl);
  if (app?.kind !== "mcp") {
    url.searchParams.set("app", app?.deepLinkAppId ?? input.appId);
  }
  const teamId = input.teamId?.trim();
  if (teamId) url.searchParams.set("teamId", teamId);
  return url.toString();
}

export function normalizeConnectedAppId(
  value: string | null | undefined,
): ConnectedAppId | null {
  const normalized = value?.trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (!normalized) return null;
  if (normalized === "teams" || normalized === "microsoft") return "microsoft_teams";
  return CONNECTED_APP_CATALOG.some((app) => app.id === normalized)
    ? (normalized as ConnectedAppId)
    : null;
}

export function normalizeConnectedAppProviderFamilyId(
  value: string | null | undefined,
): ConnectedAppProviderFamilyId | null {
  const normalized = value?.trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (!normalized) return null;
  if (
    normalized === "teams" ||
    normalized === "microsoft"
  ) {
    return "microsoft_teams";
  }
  if (CONNECTED_APP_PROVIDER_ORDER.includes(normalized as ConnectedAppProviderFamilyId)) {
    return normalized as ConnectedAppProviderFamilyId;
  }
  const app = connectedAppById(normalized);
  return app?.providerFamily ?? null;
}

export function buildConnectedAppStatusRows(input: {
  connections?: ConnectedAppConnectionLike[] | null;
} = {}): ConnectedAppStatusRow[] {
  const connections = normalizeConnections(input.connections ?? []);
  return CONNECTED_APP_CATALOG.map((entry) => {
    const bundle = connectedAppBundleByProvider(entry.providerFamily)!;
    const matchingConnections =
      entry.statusSource === "integration_connection"
        ? connections.filter((connection) => connection.provider === entry.providerFamily)
        : [];
    const connected = matchingConnections.some((connection) => connection.status === "active");
    const status = surfaceStatus(entry, connected);
    return {
      ...entry,
      providerLabel: bundle.label,
      setupSurfaceLabel: setupSurfaceLabel(entry.setupSurface),
      status,
      statusLabel: statusLabel(entry, status, matchingConnections),
      connections: matchingConnections,
      connected,
      capabilities: capabilitiesForSurface(entry, bundle.capabilities),
      capabilityLabels: capabilitiesForSurface(entry, bundle.capabilities).map(
        (capability) => capability.label,
      ),
      leasePolicy: bundle.leasePolicy,
    };
  });
}

function capability(
  id: string,
  label: string,
  description: string,
  access: ConnectedAppCapabilityAccess,
  leaseable: boolean,
): ConnectedAppCapability {
  return { id, label, description, access, leaseable };
}

function catalogEntry(entry: ConnectedAppCatalogEntry): ConnectedAppCatalogEntry {
  return entry;
}

function providerOperation(
  id: string,
  operation: ConnectedAppProviderToolOperation,
  label: string,
  description: string,
  capabilityIds: string[],
  input?: ConnectedAppProviderOperationInputSpec,
): ConnectedAppProviderOperationDescriptor {
  return {
    id,
    operation,
    label,
    description,
    capabilityIds,
    ...(input ? { input } : {}),
    requiresReadback: operation === "write",
    requiresRuntimeLease: false,
  };
}

function providerOperationIdFromArgs(args: Record<string, unknown>): string | null {
  return normalizeProviderOperationId(args.operation);
}

function normalizeProviderOperationId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function providerOperationInputFromArgs(
  args: Record<string, unknown>,
  operation: ConnectedAppProviderToolOperation,
): Record<string, unknown> {
  if (operation === "write") {
    return isRecord(args.input) ? args.input : {};
  }
  return args;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeOpenPondWebBaseUrl(value: string | null | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return DEFAULT_OPENPOND_WEB_BASE_URL;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return DEFAULT_OPENPOND_WEB_BASE_URL;
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return DEFAULT_OPENPOND_WEB_BASE_URL;
  }
}

function providerFamilyLabel(provider: ConnectedAppProviderFamilyId): string {
  if (provider === "microsoft_teams") return "Microsoft Teams";
  if (provider === "mcp") return "OpenPond MCP";
  if (provider === "x") return "X";
  return provider[0]!.toUpperCase() + provider.slice(1);
}

function setupSurfaceLabel(surface: ConnectedAppSetupSurface): string {
  if (surface === "native_bot") return "Native app";
  if (surface === "oauth_connector") return "OAuth connector";
  return "MCP endpoint";
}

function providerSkills(
  provider: ConnectedAppProviderFamilyId,
): ConnectedAppSkillDescriptor[] {
  return [integrationSkillDescriptor(provider)];
}

function integrationSkillDescriptor(
  provider: ConnectedAppProviderFamilyId,
): ConnectedAppSkillDescriptor {
  return {
    name: `${provider}-connected-app`,
    description: `Use ${providerFamilyLabel(provider)} safely through connected app tools.`,
    path: `integration_skills/${provider}.md`,
  };
}

function providerTools(
  provider: ConnectedAppProviderFamilyId,
): ConnectedAppToolDescriptor[] {
  if (provider === "mcp") return [];
  const capabilities = CAPABILITIES[provider];
  const readCapabilityIds = capabilities
    .filter((capability) => capability.access === "read")
    .map((capability) => capability.id);
  const writeCapabilityIds = capabilities
    .filter((capability) => capability.access === "write")
    .map((capability) => capability.id);
  const tools: ConnectedAppToolDescriptor[] = [];
  if (readCapabilityIds.length > 0) {
    tools.push(
      {
        name: "connected_app_search",
        description: `Search ${providerFamilyLabel(provider)} through a server-owned connected app connector.`,
        capabilityIds: readCapabilityIds,
        write: false,
      },
      {
        name: "connected_app_read",
        description: `Read a grounded ${providerFamilyLabel(provider)} object through a server-owned connected app connector.`,
        capabilityIds: readCapabilityIds,
        write: false,
      },
    );
  }
  if (writeCapabilityIds.length > 0) {
    tools.push({
      name: "connected_app_write",
      description: `Perform an explicitly approved ${providerFamilyLabel(provider)} write through a server-owned connected app connector.`,
      capabilityIds: writeCapabilityIds,
      write: true,
    });
  }
  return tools;
}

function toolNameForOperation(
  operation: ConnectedAppProviderToolOperation,
): ConnectedAppProviderToolName {
  if (operation === "search") return "connected_app_search";
  if (operation === "read") return "connected_app_read";
  return "connected_app_write";
}

function leasePolicy(provider: ConnectedAppProviderFamilyId): ConnectedAppLeasePolicy {
  const capabilities = CAPABILITIES[provider].filter((item) => item.leaseable).map((item) => item.id);
  const leaseable = provider !== "mcp" && capabilities.length > 0;
  return {
    leaseable,
    defaultTtlSeconds: leaseable ? 3600 : null,
    allowedCapabilityIds: capabilities,
    requiresProxy: leaseable,
  };
}

function capabilitiesForSurface(
  entry: ConnectedAppCatalogEntry,
  capabilities: ConnectedAppCapability[],
): ConnectedAppCapability[] {
  if (entry.setupSurface === "native_bot") {
    return capabilities.filter((capability) => capability.access === "setup");
  }
  if (entry.setupSurface === "mcp_endpoint") return capabilities;
  return capabilities.filter((capability) => capability.access !== "setup");
}

function normalizeConnections(
  connections: ConnectedAppConnectionLike[],
): ConnectedAppStatusConnection[] {
  return connections.flatMap((connection) => {
    const provider = normalizeConnectedAppProviderFamilyId(connection.provider);
    if (!provider) return [];
    return [
      {
        id: connection.id ?? null,
        teamId: connection.teamId?.trim() || null,
        provider,
        accountLabel: connection.providerAccountName ?? null,
        workspaceLabel: connection.providerWorkspaceName ?? null,
        scopes: Array.isArray(connection.scopes) ? connection.scopes : [],
        capabilities: Array.isArray(connection.capabilities) ? connection.capabilities : [],
        status: connection.status?.trim().toLowerCase() || "active",
      },
    ];
  });
}

function surfaceStatus(
  entry: ConnectedAppCatalogEntry,
  connected: boolean,
): ConnectedAppSurfaceState {
  if (entry.statusSource === "integration_connection") {
    return connected ? "connected" : "disconnected";
  }
  return "setup_available";
}

function statusLabel(
  entry: ConnectedAppCatalogEntry,
  status: ConnectedAppSurfaceState,
  connections: ConnectedAppStatusConnection[],
): string {
  if (status === "connected") {
    const activeCount = connections.filter((connection) => connection.status === "active").length;
    return activeCount > 1 ? `${activeCount} connected` : "Connected";
  }
  if (status === "disconnected") return "Not connected";
  if (entry.statusSource === "native_binding") return "Bot setup";
  return "Configure";
}

function hashString(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}
