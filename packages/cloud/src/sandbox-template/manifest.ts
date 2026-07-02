import yaml from "js-yaml";
import { z } from "zod";

export const SANDBOX_TEMPLATE_PREVIEW_PORT_MIN = 3000;
export const SANDBOX_TEMPLATE_PREVIEW_PORT_MAX = 9999;
export const OPENPOND_MANIFEST_FILE_NAME = "openpond.yaml";
export const SANDBOX_TEMPLATE_BUILD_PLAN_FILE_NAME =
  "openpond-template-plan.json";
export const SANDBOX_TEMPLATE_BUILD_PLAN_KIND =
  "openpond.sandboxTemplate.buildPlan.v1";

const INTEGRATION_PROVIDERS = [
  "google",
  "slack",
  "github",
  "microsoft_teams",
  "x",
  "notion",
  "linear",
] as const;

const RESERVED_PREVIEW_PORTS = new Set([
  22, 2222, 2375, 2376, 3108, 5900, 5901, 6080, 7818,
]);

const CommandListSchema = z.array(z.string().trim().min(1).max(1000)).max(50);

const RelativeWorkspacePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine(isSafeRelativeWorkspacePath, {
    message: "path must be a relative workspace path",
  });

const OciImageRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine(
    (value) => !value.includes("\0") && !/\s/.test(value),
    "image ref must be a single OCI reference"
  );

const OciDigestSchema = z
  .string()
  .trim()
  .regex(/^sha256:[0-9a-f]{64}$/i);

const RuntimeWorkspaceRootSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine(
    (value) => value.startsWith("/") && !value.includes("\0"),
    "workspaceRoot must be an absolute guest path"
  );

const DockerfileRuntimeImageSchema = z
  .object({
    ref: OciImageRefSchema,
    digest: OciDigestSchema.optional(),
    registrySecretRef: z.string().trim().min(1).max(500).optional(),
    platform: z.literal("linux/amd64").optional(),
    workspaceRoot: RuntimeWorkspaceRootSchema.optional(),
  })
  .strict();

const DockerfileRuntimeSourceSchema = z
  .object({
    context: RelativeWorkspacePathSchema.default("."),
    path: RelativeWorkspacePathSchema.default("Dockerfile"),
    target: z.string().trim().min(1).max(191).optional(),
    buildArgs: z.record(z.string().max(191), z.string().max(500)).optional(),
    registrySecretRefs: z
      .array(z.string().trim().min(1).max(500))
      .max(10)
      .optional(),
    platform: z.literal("linux/amd64").optional(),
    workspaceRoot: RuntimeWorkspaceRootSchema.optional(),
  })
  .strict();

const SandboxTemplateRuntimeSchema = z
  .object({
    base: z.string().trim().min(1).max(120).optional(),
    snapshot: z.string().trim().min(1).max(191).optional(),
    image: DockerfileRuntimeImageSchema.optional(),
    dockerfile: DockerfileRuntimeSourceSchema.optional(),
  })
  .strict()
  .superRefine((runtime, context) => {
    const selected = [
      runtime.base,
      runtime.snapshot,
      runtime.image,
      runtime.dockerfile,
    ].filter(Boolean).length;
    if (selected !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "runtime must declare exactly one of base, snapshot, image, or dockerfile",
      });
    }
  });

const SandboxTemplateResourcesSchema = z
  .object({
    cpu: z.number().positive().max(8).optional(),
    memoryGb: z.number().positive().max(32).optional(),
    diskGb: z.number().positive().max(100).optional(),
  })
  .strict();

const SandboxTemplateRequiredLeaseSchema = z
  .object({
    provider: z.enum(INTEGRATION_PROVIDERS),
    scopes: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
    capabilities: z
      .array(z.string().trim().min(1).max(200))
      .max(100)
      .default([]),
  })
  .strict();

const SandboxTemplateOpChatPermissionsSchema = z
  .object({
    models: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
    scopes: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
  })
  .strict();

const SandboxTemplatePermissionsSchema = z
  .object({
    opchat: SandboxTemplateOpChatPermissionsSchema.optional(),
  })
  .catchall(z.record(z.string(), z.unknown()))
  .default({});

const SandboxTemplateVolumeSchema = z
  .object({
    name: z
      .string()
      .trim()
      .regex(/^[A-Za-z_][A-Za-z0-9_-]*$/)
      .max(63)
      .optional(),
    mountPath: z.string().trim().min(1).max(256).optional(),
    storageGb: z.number().int().positive().max(100).optional(),
    deleteOnSandboxDelete: z.boolean().optional(),
  })
  .strict();

const SandboxTemplatePortSchema = z
  .object({
    port: z
      .number()
      .int()
      .min(SANDBOX_TEMPLATE_PREVIEW_PORT_MIN)
      .max(SANDBOX_TEMPLATE_PREVIEW_PORT_MAX)
      .refine((port) => !RESERVED_PREVIEW_PORTS.has(port), {
        message: "preview port is reserved",
      }),
    protocol: z.literal("http").default("http"),
    label: z.string().trim().min(1).max(80).optional(),
    access: z.enum(["private", "public"]).default("private"),
    path: z
      .string()
      .trim()
      .min(1)
      .max(512)
      .refine((value) => value.startsWith("/"), {
        message: "preview path must start with /",
      })
      .default("/"),
  })
  .strict();

const SandboxTemplateCommandSchema = z
  .object({
    command: z.string().trim().min(1).max(1000),
    cwd: RelativeWorkspacePathSchema.optional(),
    timeoutSeconds: z.number().int().positive().max(86_400).optional(),
    requiresStart: z.boolean().default(false),
    ports: z.array(SandboxTemplatePortSchema).max(20).default([]),
    artifactPaths: z.array(RelativeWorkspacePathSchema).max(100).default([]),
  })
  .strict();

const SandboxTemplateNamedCommandSchema = SandboxTemplateCommandSchema.extend({
  name: z.string().trim().min(1).max(80),
}).strict();

const SandboxTemplateMcpEndpointSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    service: z.string().trim().min(1).max(80).optional(),
    port: z
      .number()
      .int()
      .min(SANDBOX_TEMPLATE_PREVIEW_PORT_MIN)
      .max(SANDBOX_TEMPLATE_PREVIEW_PORT_MAX)
      .refine((port) => !RESERVED_PREVIEW_PORTS.has(port), {
        message: "app MCP port is reserved",
      }),
    path: z
      .string()
      .trim()
      .min(1)
      .max(512)
      .refine((value) => value.startsWith("/"), {
        message: "app MCP path must start with /",
      })
      .default("/mcp"),
  })
  .strict();

const SandboxTemplateValidationProbeSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    port: z
      .number()
      .int()
      .min(SANDBOX_TEMPLATE_PREVIEW_PORT_MIN)
      .max(SANDBOX_TEMPLATE_PREVIEW_PORT_MAX)
      .refine((port) => !RESERVED_PREVIEW_PORTS.has(port), {
        message: "validation probe port is reserved",
      }),
    path: z
      .string()
      .trim()
      .min(1)
      .max(512)
      .refine((value) => value.startsWith("/"), {
        message: "validation probe path must start with /",
      })
      .default("/"),
    expectedStatus: z.number().int().min(100).max(599).default(200),
  })
  .strict();

const SandboxTemplateJsonSchema = z
  .record(z.string(), z.unknown())
  .refine(
    (schema) => schema.type === "object",
    "input schema must be a JSON schema object"
  );

const SandboxTemplateEnvInputSchema = z
  .object({
    name: z
      .string()
      .trim()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .max(191),
    required: z.boolean().default(false),
    secret: z.boolean().default(true),
    description: z.string().trim().max(500).optional(),
  })
  .strict();

const SandboxTemplateScheduleDateSchema = z.string().trim().min(1).max(120);

const SandboxTemplateScheduleSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).optional(),
    cron: z.string().trim().min(1).max(500).optional(),
    rate: z.string().trim().min(1).max(500).optional(),
    once: SandboxTemplateScheduleDateSchema.optional(),
    scheduleType: z.enum(["rate", "cron", "once"]).optional(),
    scheduleExpression: z.string().trim().min(1).max(500).optional(),
    timezone: z.string().trim().min(1).max(100).optional(),
    enabled: z.boolean().default(true),
    startAt: SandboxTemplateScheduleDateSchema.optional(),
    endAt: SandboxTemplateScheduleDateSchema.optional(),
    maxRuns: z.number().int().positive().nullable().optional(),
    runtimePolicy: z
      .enum([
        "run_and_stop",
        "run_and_archive",
        "run_and_delete",
        "use_existing_running",
      ])
      .default("run_and_stop"),
    action: z.string().trim().min(1).max(120).optional(),
    actionName: z.string().trim().min(1).max(120).optional(),
    command: z.string().trim().min(1).max(2000).optional(),
    target: z
      .object({
        kind: z.enum(["start", "action", "service", "command"]).optional(),
        name: z.string().trim().min(1).max(120).optional(),
        actionName: z.string().trim().min(1).max(120).optional(),
        command: z.string().trim().min(1).max(2000).optional(),
        requiresStart: z.boolean().optional(),
      })
      .strict()
      .optional(),
    requiresStart: z.boolean().optional(),
    budget: z
      .object({
        maxUsd: z.string().trim().min(1).max(40).optional(),
      })
      .strict()
      .optional(),
    resources: SandboxTemplateResourcesSchema.optional(),
    quotas: z.record(z.string(), z.unknown()).optional(),
    lifecycle: z.record(z.string(), z.unknown()).optional(),
    retentionPolicy: z.record(z.string(), z.unknown()).optional(),
    env: z
      .array(
        z
          .object({
            name: z
              .string()
              .trim()
              .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
              .max(191),
            value: z.string().optional(),
            secretRef: z.string().optional(),
          })
          .strict()
      )
      .max(100)
      .optional(),
    integrationLeases: z
      .array(z.record(z.string(), z.unknown()))
      .max(20)
      .optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine((schedule, context) => {
    const expressionCount = [
      schedule.cron,
      schedule.rate,
      schedule.once,
      schedule.scheduleExpression,
    ].filter((value) => typeof value === "string" && value.trim()).length;
    if (expressionCount !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scheduleExpression"],
        message:
          "schedule must declare exactly one of cron, rate, once, or scheduleExpression",
      });
    }
    if (schedule.scheduleExpression && !schedule.scheduleType) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scheduleType"],
        message: "scheduleType is required with scheduleExpression",
      });
    }
    const command = schedule.command ?? schedule.target?.command ?? null;
    const targetName = schedule.target?.name ?? null;
    const actionName =
      schedule.actionName ??
      schedule.action ??
      schedule.target?.actionName ??
      (schedule.target?.kind === "action" ? targetName : null);
    const kind = schedule.target?.kind ?? (command ? "command" : "action");
    if (kind === "action" && !actionName) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["action"],
        message: "schedule action target is required",
      });
    }
    if (kind === "service" && !targetName) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["target", "name"],
        message: "schedule service target name is required",
      });
    }
    if (kind === "command" && !command) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["command"],
        message: "schedule command target is required",
      });
    }
  });

export const SandboxTemplateManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    name: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/),
    version: z.string().trim().min(1).max(40),
    useCase: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(500),
    runtime: SandboxTemplateRuntimeSchema,
    resources: SandboxTemplateResourcesSchema.optional(),
    setup: z
      .object({
        commands: CommandListSchema.default([]),
      })
      .strict()
      .default({ commands: [] }),
    validation: z
      .object({
        commands: CommandListSchema.min(1),
        probes: z
          .array(SandboxTemplateValidationProbeSchema)
          .max(20)
          .default([]),
      })
      .strict(),
    start: SandboxTemplateCommandSchema,
    actions: z.array(SandboxTemplateNamedCommandSchema).max(20).default([]),
    services: z.array(SandboxTemplateNamedCommandSchema).max(20).default([]),
    schedules: z.array(SandboxTemplateScheduleSchema).max(20).default([]),
    mcp: z
      .object({
        endpoints: z
          .array(SandboxTemplateMcpEndpointSchema)
          .max(10)
          .default([]),
      })
      .strict()
      .default({ endpoints: [] }),
    volumes: z.array(SandboxTemplateVolumeSchema).max(5).default([]),
    integrations: z
      .object({
        requiredLeases: z
          .array(SandboxTemplateRequiredLeaseSchema)
          .max(20)
          .default([]),
      })
      .strict()
      .default({ requiredLeases: [] }),
    permissions: SandboxTemplatePermissionsSchema,
    inputs: z
      .object({
        schema: SandboxTemplateJsonSchema.default({ type: "object" }),
        env: z.array(SandboxTemplateEnvInputSchema).max(100).default([]),
      })
      .strict()
      .default({ schema: { type: "object" }, env: [] }),
    artifacts: z
      .object({
        paths: z.array(RelativeWorkspacePathSchema).max(100).default([]),
      })
      .strict()
      .default({ paths: [] }),
    network: z
      .object({
        egress: z.enum(["restricted", "allow", "block"]).default("restricted"),
      })
      .strict()
      .default({ egress: "restricted" }),
  })
  .strict()
  .superRefine((manifest, context) => {
    validateExecutableNames(manifest, context);
    addDuplicateNameIssue(
      context,
      manifest.volumes.flatMap((volume) => (volume.name ? [volume.name] : [])),
      "volume names must be unique",
      "volumes"
    );
    validateInputSchemaUploadTargets(manifest, context);
    validateEnvInputs(manifest, context);
    validateMcpEndpoints(manifest, context);
    validateScheduleTargets(manifest, context);
  });

export type SandboxTemplateManifest = z.infer<
  typeof SandboxTemplateManifestSchema
>;
export type SandboxTemplateResources = NonNullable<
  SandboxTemplateManifest["resources"]
>;
export type SandboxTemplatePort =
  SandboxTemplateManifest["start"]["ports"][number];
export type SandboxTemplateCommand = SandboxTemplateManifest["start"];
export type SandboxTemplateNamedCommand =
  SandboxTemplateManifest["actions"][number];
export type SandboxTemplateSchedule =
  SandboxTemplateManifest["schedules"][number];
export type SandboxTemplateVolume = SandboxTemplateManifest["volumes"][number];
export type SandboxTemplateExecutableKind = "start" | "action" | "service";

export type SandboxTemplateExecutable = SandboxTemplateCommand & {
  kind: SandboxTemplateExecutableKind;
  name: string;
};

export type SandboxTemplateBuildPlan = {
  kind: typeof SANDBOX_TEMPLATE_BUILD_PLAN_KIND;
  schemaVersion: 1;
  manifestFile: string;
  projectRoot: string;
  manifest: SandboxTemplateManifest;
  metadata: Record<string, unknown>;
  executables: SandboxTemplateExecutable[];
};

export type SandboxTemplateValidationDiagnostic = {
  path: string;
  message: string;
  code: string;
};

export type SandboxTemplateValidationResult =
  | {
      ok: true;
      manifest: SandboxTemplateManifest;
      diagnostics: [];
    }
  | {
      ok: false;
      manifest: null;
      diagnostics: SandboxTemplateValidationDiagnostic[];
    };

export const SandboxTemplateValidationDiagnosticSchema = z.object({
  path: z.string(),
  message: z.string(),
  code: z.string(),
});

export function validateSandboxTemplateYaml(
  source: string
): SandboxTemplateValidationResult {
  let parsed: unknown;
  try {
    parsed = yaml.load(source);
  } catch (error) {
    return {
      ok: false,
      manifest: null,
      diagnostics: [
        {
          path: "$",
          code: "invalid_yaml",
          message: error instanceof Error ? error.message : "Invalid YAML",
        },
      ],
    };
  }
  return validateSandboxTemplateManifest(parsed);
}

export function validateSandboxTemplateManifest(
  value: unknown
): SandboxTemplateValidationResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      manifest: null,
      diagnostics: [
        {
          path: "$",
          code: "invalid_type",
          message: `${OPENPOND_MANIFEST_FILE_NAME} must be an object`,
        },
      ],
    };
  }
  if (Object.prototype.hasOwnProperty.call(value, "databases")) {
    return {
      ok: false,
      manifest: null,
      diagnostics: [
        {
          path: "$.databases",
          code: "database_resources_removed",
          message:
            "managed database requests are unsupported for Firecracker sandbox templates; use a durable volume with SQLite or files instead",
        },
      ],
    };
  }
  const result = SandboxTemplateManifestSchema.safeParse(value);
  if (result.success)
    return { ok: true, manifest: result.data, diagnostics: [] };
  return {
    ok: false,
    manifest: null,
    diagnostics: result.error.issues.map((issue) => ({
      path: formatIssuePath(issue.path),
      code: issue.code,
      message: issue.message,
    })),
  };
}

export function parseSandboxTemplateYaml(
  source: string
): SandboxTemplateManifest {
  const result = validateSandboxTemplateYaml(source);
  if (!result.ok) {
    throw new Error(formatSandboxTemplateDiagnostics(result.diagnostics));
  }
  return result.manifest;
}

export function formatSandboxTemplateDiagnostics(
  diagnostics: SandboxTemplateValidationDiagnostic[]
): string {
  return diagnostics
    .map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`)
    .join("\n");
}

export function defineSandboxTemplate<T extends SandboxTemplateManifest>(
  template: T
): T {
  return SandboxTemplateManifestSchema.parse(template) as T;
}

export function sandboxTemplateResources(
  resources: Partial<SandboxTemplateResources> = {}
): SandboxTemplateResources {
  return SandboxTemplateResourcesSchema.parse(resources);
}

export function sandboxTemplateDurableVolume(
  volume: SandboxTemplateVolume
): SandboxTemplateVolume {
  return SandboxTemplateVolumeSchema.parse({
    ...volume,
    deleteOnSandboxDelete: volume.deleteOnSandboxDelete ?? false,
  });
}

export function sandboxTemplatePreviewPort(
  port: number,
  options: Omit<Partial<SandboxTemplatePort>, "port"> = {}
): SandboxTemplatePort {
  return SandboxTemplatePortSchema.parse({
    ...options,
    port,
  });
}

export type SandboxTemplateFileInputOptions = {
  targetPath: string;
  title?: string;
  description?: string;
  accept?: string[];
  multiple?: boolean;
};

export type SandboxTemplateFileInputSchema =
  | {
      type: "string";
      format: "file";
      title?: string;
      description?: string;
      "x-openpond-upload": {
        targetPath: string;
        accept?: string[];
        multiple?: false;
      };
    }
  | {
      type: "array";
      title?: string;
      description?: string;
      items: {
        type: "string";
        format: "file";
      };
      "x-openpond-upload": {
        targetPath: string;
        accept?: string[];
        multiple: true;
      };
    };

export function sandboxTemplateFileInput(
  options: SandboxTemplateFileInputOptions
): SandboxTemplateFileInputSchema {
  const targetPath = RelativeWorkspacePathSchema.parse(options.targetPath);
  const accept = options.accept
    ?.map((value) => value.trim())
    .filter((value) => value.length > 0);
  const upload = {
    targetPath,
    ...(accept && accept.length > 0 ? { accept } : {}),
  };
  const base = {
    ...(options.title?.trim() ? { title: options.title.trim() } : {}),
    ...(options.description?.trim()
      ? { description: options.description.trim() }
      : {}),
    "x-openpond-upload": upload,
  };
  if (options.multiple) {
    return {
      ...base,
      "x-openpond-upload": {
        ...upload,
        multiple: true,
      },
      type: "array",
      items: { type: "string", format: "file" },
    };
  }
  return {
    ...base,
    type: "string",
    format: "file",
  };
}

export function sandboxTemplateExecutableEntries(
  manifest: SandboxTemplateManifest
): SandboxTemplateExecutable[] {
  return [
    {
      kind: "start",
      name: "start",
      ...manifest.start,
      artifactPaths: commandArtifactPaths(manifest.start, manifest),
    },
    ...manifest.actions.map((action) => ({
      kind: "action" as const,
      name: action.name,
      command: action.command,
      cwd: action.cwd,
      timeoutSeconds: action.timeoutSeconds,
      requiresStart: action.requiresStart,
      ports: action.ports,
      artifactPaths: commandArtifactPaths(action, manifest),
    })),
    ...manifest.services.map((service) => ({
      kind: "service" as const,
      name: service.name,
      command: service.command,
      cwd: service.cwd,
      timeoutSeconds: service.timeoutSeconds,
      requiresStart: service.requiresStart,
      ports: service.ports,
      artifactPaths: commandArtifactPaths(service, manifest),
    })),
  ];
}

export function sandboxTemplateBuildMetadata(
  manifest: SandboxTemplateManifest
): Record<string, unknown> {
  const executables = sandboxTemplateExecutableEntries(manifest);
  return {
    template: {
      name: manifest.name,
      version: manifest.version,
      useCase: manifest.useCase,
      runtime: manifest.runtime,
    },
    resources: manifest.resources ?? null,
    volumes: manifest.volumes,
    executables: executables.map((entry) => ({
      kind: entry.kind,
      name: entry.name,
      command: entry.command,
      cwd: entry.cwd ?? null,
      timeoutSeconds: entry.timeoutSeconds ?? null,
      requiresStart: entry.requiresStart,
      ports: entry.ports.map((port) => port.port),
      artifactPaths: entry.artifactPaths,
    })),
    ports: executables.flatMap((entry) =>
      entry.ports.map((port) => ({
        executable: entry.name,
        kind: entry.kind,
        port: port.port,
        access: port.access,
        label: port.label ?? null,
      }))
    ),
    appMcpEndpoints: manifest.mcp.endpoints.map((endpoint) => ({
      name: endpoint.name ?? null,
      service: endpoint.service ?? null,
      port: endpoint.port,
      path: endpoint.path,
    })),
    validation: {
      commands: manifest.validation.commands,
      probes: manifest.validation.probes,
    },
    schedules: manifest.schedules,
  };
}

export function sandboxTemplateBuildPlan(input: {
  manifest: SandboxTemplateManifest;
  manifestFile: string;
  projectRoot: string;
}): SandboxTemplateBuildPlan {
  return {
    kind: SANDBOX_TEMPLATE_BUILD_PLAN_KIND,
    schemaVersion: 1,
    manifestFile: input.manifestFile,
    projectRoot: input.projectRoot,
    manifest: input.manifest,
    metadata: sandboxTemplateBuildMetadata(input.manifest),
    executables: sandboxTemplateExecutableEntries(input.manifest),
  };
}

export type SandboxTemplateScaffoldInput = {
  name: string;
  description?: string;
};

export function sandboxTemplateScaffoldFiles(
  input: SandboxTemplateScaffoldInput
): Record<string, string> {
  const displayName = input.name.trim() || "Sandbox Template";
  const name = slug(displayName);
  const description =
    input.description?.trim() || `Local scaffold for ${displayName}.`;
  return {
    ".gitignore": ["node_modules", "artifacts", ".DS_Store", ""].join("\n"),
    "README.md": [
      `# ${displayName}`,
      "",
      "Local sandbox template scaffold.",
      "",
      "## Commands",
      "",
      "- `bun run dev` starts the preview service on port 3000.",
      "- `bun run process` writes a sample artifact.",
      `- \`bun run validate\` validates ${OPENPOND_MANIFEST_FILE_NAME}.`,
      "",
    ].join("\n"),
    "package.json": `${JSON.stringify(
      {
        private: true,
        type: "module",
        scripts: {
          dev: "bun src/server.ts",
          process: "bun scripts/process.ts",
          validate: `openpond sandbox-template validate --file ${OPENPOND_MANIFEST_FILE_NAME}`,
        },
      },
      null,
      2
    )}\n`,
    [OPENPOND_MANIFEST_FILE_NAME]: [
      "schemaVersion: 1",
      `name: ${name}`,
      "version: 0.1.0",
      "useCase: sandbox-template-scaffold",
      `description: ${description}`,
      "runtime:",
      "  base: node-bun-workspace",
      "resources:",
      "  cpu: 1",
      "  memoryGb: 1",
      "  diskGb: 8",
      "setup:",
      "  commands:",
      "    - mkdir -p artifacts",
      "validation:",
      "  commands:",
      "    - test -f src/server.ts",
      "    - test -f scripts/process.ts",
      "start:",
      "  command: bun run process",
      "  timeoutSeconds: 300",
      "  ports: []",
      "  artifactPaths:",
      "    - artifacts/result.json",
      "actions: []",
      "schedules: []",
      "services:",
      "  - name: web",
      "    command: bun run dev",
      "    timeoutSeconds: 3600",
      "    ports:",
      "      - port: 3000",
      "        protocol: http",
      "        label: web",
      "        access: private",
      "        path: /",
      "    artifactPaths: []",
      "inputs:",
      "  env:",
      "    - name: FOO_API_KEY",
      "      required: false",
      "      secret: true",
      "      description: API key used by the sample action.",
      "  schema:",
      "    type: object",
      "    properties:",
      "      subject:",
      "        type: string",
      "        title: Subject",
      "        default: Example",
      "artifacts:",
      "  paths:",
      "    - artifacts/result.json",
      "network:",
      "  egress: restricted",
      "",
    ].join("\n"),
    "src/server.ts": [
      "Bun.serve({",
      "  host: '0.0.0.0',",
      "  port: 3000,",
      "  fetch() {",
      "    return Response.json({ ok: true, template: 'sandbox-template-scaffold' });",
      "  },",
      "});",
      "",
    ].join("\n"),
    "scripts/process.ts": [
      "import { mkdir, writeFile } from 'node:fs/promises';",
      "",
      "const raw = process.env.OPENPOND_REPLAY_PARAMS_BASE64;",
      "const params = raw ? JSON.parse(Buffer.from(raw, 'base64').toString('utf8')).input ?? {} : {};",
      "await mkdir('artifacts', { recursive: true });",
      "await writeFile('artifacts/result.json', JSON.stringify({ ok: true, input: params }, null, 2));",
      "console.log('wrote artifacts/result.json');",
      "",
    ].join("\n"),
    "fixtures/input.txt": "Example input\n",
  };
}

export function sandboxTemplateJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(SandboxTemplateManifestSchema) as Record<
    string,
    unknown
  >;
}

function isSafeRelativeWorkspacePath(value: string): boolean {
  return (
    !value.includes("\0") &&
    !value.startsWith("/") &&
    !value.split(/[\\/]+/).some((segment) => segment === ".." || segment === "")
  );
}

function formatIssuePath(path: PropertyKey[]): string {
  if (path.length === 0) return "$";
  return `$${path
    .map((part) =>
      typeof part === "number" ? `[${part}]` : `.${String(part)}`
    )
    .join("")}`;
}

function addDuplicateNameIssue(
  context: z.RefinementCtx,
  names: string[],
  message: string,
  path: string
): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [path],
        message,
      });
      return;
    }
    seen.add(name);
  }
}

function validateExecutableNames(
  manifest: {
    actions: Array<{ name: string }>;
    services: Array<{ name: string }>;
  },
  context: z.RefinementCtx
): void {
  const names = [
    "start",
    ...manifest.actions.map((action) => action.name),
    ...manifest.services.map((service) => service.name),
  ];
  addDuplicateNameIssue(
    context,
    names,
    "start, action, and service names must be unique",
    "actions"
  );
}

function validateInputSchemaUploadTargets(
  manifest: {
    inputs: { schema: Record<string, unknown> };
    volumes: Array<{ name?: string }>;
  },
  context: z.RefinementCtx
): void {
  const properties = asRecord(manifest.inputs.schema.properties);
  const volumeNames = new Set(
    manifest.volumes
      .map((volume) => volume.name)
      .filter((name): name is string => Boolean(name))
  );
  for (const [inputName, rawProperty] of Object.entries(properties)) {
    const property = asRecord(rawProperty);
    const upload = asRecord(
      property["x-openpond-upload"] ?? property.xOpenPondUpload
    );
    const targetPath =
      typeof upload.targetPath === "string" && upload.targetPath.trim()
        ? upload.targetPath.trim()
        : typeof upload.path === "string" && upload.path.trim()
        ? upload.path.trim()
        : "";
    if (!targetPath) continue;
    const normalizedTargetPath = targetPath
      .replace(/^workspace\//, "")
      .replace(/^\/+/, "")
      .replace(/\/+$/, "");
    if (!isSafeRelativeWorkspacePath(normalizedTargetPath)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [
          "inputs",
          "schema",
          "properties",
          inputName,
          "x-openpond-upload",
          "targetPath",
        ],
        message: "upload target must be a relative workspace path",
      });
      continue;
    }
    const parts = normalizedTargetPath.split("/");
    if (parts[0] === "volumes" && (!parts[1] || !volumeNames.has(parts[1]))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [
          "inputs",
          "schema",
          "properties",
          inputName,
          "x-openpond-upload",
          "targetPath",
        ],
        message: "upload target references an undeclared volume",
      });
    }
  }
}

function validateEnvInputs(
  manifest: {
    inputs: { env: Array<{ name: string }> };
  },
  context: z.RefinementCtx
): void {
  addDuplicateNameIssue(
    context,
    manifest.inputs.env.map((env) => env.name),
    "env input names must be unique",
    "inputs"
  );
}

function validateMcpEndpoints(
  manifest: {
    services: Array<{ name: string; ports: Array<{ port: number }> }>;
    start: { ports: Array<{ port: number }> };
    mcp: { endpoints: Array<{ service?: string; port: number }> };
  },
  context: z.RefinementCtx
): void {
  const servicePorts = new Map(
    manifest.services.map((service) => [
      service.name,
      new Set(service.ports.map((port) => port.port)),
    ])
  );
  const declaredPorts = new Set([
    ...manifest.start.ports.map((port) => port.port),
    ...manifest.services.flatMap((service) =>
      service.ports.map((port) => port.port)
    ),
  ]);
  for (const [index, endpoint] of manifest.mcp.endpoints.entries()) {
    if (endpoint.service) {
      const ports = servicePorts.get(endpoint.service);
      if (!ports) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["mcp", "endpoints", index, "service"],
          message: `app MCP service does not exist: ${endpoint.service}`,
        });
        continue;
      }
      if (!ports.has(endpoint.port)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["mcp", "endpoints", index, "port"],
          message: `app MCP port ${endpoint.port} is not declared on service ${endpoint.service}`,
        });
      }
      continue;
    }
    if (!declaredPorts.has(endpoint.port)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mcp", "endpoints", index, "port"],
        message: `app MCP port ${endpoint.port} is not declared on start or services`,
      });
    }
  }
}

function validateScheduleTargets(
  manifest: {
    actions: Array<{ name: string }>;
    services: Array<{ name: string }>;
    schedules: Array<{
      action?: string;
      actionName?: string;
      command?: string;
      target?: {
        kind?: "start" | "action" | "service" | "command";
        name?: string;
        actionName?: string;
        command?: string;
      };
    }>;
  },
  context: z.RefinementCtx
): void {
  const actionNames = new Set(manifest.actions.map((action) => action.name));
  const serviceNames = new Set(
    manifest.services.map((service) => service.name)
  );
  for (const [index, schedule] of manifest.schedules.entries()) {
    const command = schedule.command ?? schedule.target?.command ?? null;
    if (schedule.target?.kind === "command" || command) {
      continue;
    }
    const actionName =
      schedule.actionName ??
      schedule.action ??
      schedule.target?.actionName ??
      (schedule.target?.kind === "action" ? schedule.target?.name : null);
    if (actionName && !actionNames.has(actionName)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["schedules", index, "action"],
        message: `schedule action target does not exist: ${actionName}`,
      });
    }
    if (schedule.target?.kind === "service") {
      const serviceName = schedule.target.name ?? "";
      if (serviceName && !serviceNames.has(serviceName)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["schedules", index, "target", "name"],
          message: `schedule service target does not exist: ${serviceName}`,
        });
      }
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function commandArtifactPaths(
  command: Pick<SandboxTemplateCommand, "artifactPaths">,
  manifest: SandboxTemplateManifest
): string[] {
  return command.artifactPaths.length > 0
    ? command.artifactPaths
    : manifest.artifacts.paths;
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/-{2,}/g, "-")
      .slice(0, 80) || "sandbox-template"
  );
}
