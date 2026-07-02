import type { OpenPondSandboxClient } from "../sandbox/client";
import type { SandboxScheduleCreateInput } from "../sandbox/types/index";
import {
  OPENPOND_MANIFEST_FILE_NAME,
  type SandboxTemplateManifest,
} from "../sandbox-template/manifest";
import { parseJsonOption } from "./common";

export type SandboxTemplateStartScheduleMode = "enabled" | "disabled";

export type SandboxTemplateScheduleOverride =
  Partial<SandboxScheduleCreateInput> & {
    cron?: string;
    rate?: string;
    once?: string;
    target?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  };

export async function createSandboxTemplateStartSchedules(
  client: OpenPondSandboxClient,
  sandboxId: string,
  manifest: SandboxTemplateManifest,
  options: Record<string, string | boolean>
): Promise<Array<Record<string, unknown>>> {
  const selection = resolveSandboxTemplateStartScheduleSelection(
    manifest,
    options
  );
  if (!selection) {
    return [];
  }
  const overrides = parseSandboxTemplateScheduleOverrides(manifest, options);
  const projectId =
    typeof options.projectId === "string" && options.projectId.trim()
      ? options.projectId.trim()
      : typeof options.runtimeProjectId === "string"
      ? options.runtimeProjectId.trim()
      : "";
  const teamId =
    typeof options.teamId === "string" ? options.teamId.trim() : "";
  const created: Array<Record<string, unknown>> = [];
  for (const schedule of selection.schedules) {
    const input = buildSandboxTemplateStartScheduleInput({
      manifest,
      schedule,
      override: overrides.get(schedule.name),
      mode: selection.mode,
      sourceSandboxId: sandboxId,
      teamId,
      projectId,
    });
    const result = await client.createSchedule(input);
    created.push({
      id: result.schedule.id,
      name: result.schedule.name,
      enabled: result.schedule.enabled,
      scheduleType: result.schedule.scheduleType,
      scheduleExpression: result.schedule.scheduleExpression,
      syncStatus: result.schedule.syncStatus,
      awsScheduleArn: result.schedule.awsScheduleArn ?? null,
      target: result.schedule.target,
    });
  }
  return created;
}

export function resolveSandboxTemplateStartScheduleSelection(
  manifest: SandboxTemplateManifest,
  options: Record<string, string | boolean>
): {
  mode: SandboxTemplateStartScheduleMode;
  schedules: SandboxTemplateManifest["schedules"];
} | null {
  const enableRaw = options.enableSchedules ?? options.enableSchedule;
  const disableRaw = options.disableSchedules ?? options.disableSchedule;
  if (enableRaw !== undefined && disableRaw !== undefined) {
    throw new Error(
      "pass only one of --enable-schedules or --disable-schedules"
    );
  }

  let mode: SandboxTemplateStartScheduleMode | null = null;
  let rawSelection: string | boolean | undefined;
  if (enableRaw !== undefined) {
    mode = "enabled";
    rawSelection = enableRaw;
  } else if (disableRaw !== undefined) {
    mode = "disabled";
    rawSelection = disableRaw;
  } else if (options.schedules !== undefined) {
    rawSelection = options.schedules;
    const rawMode =
      typeof options.scheduleMode === "string"
        ? options.scheduleMode.trim().toLowerCase()
        : "disabled";
    if (rawMode === "none") {
      return null;
    }
    if (rawMode !== "enabled" && rawMode !== "disabled") {
      throw new Error("--schedule-mode must be enabled, disabled, or none");
    }
    mode = rawMode;
  }

  if (!mode) {
    return null;
  }
  if (manifest.schedules.length === 0) {
    return { mode, schedules: [] };
  }
  const selectedNames = parseSandboxTemplateScheduleNameSelection(
    rawSelection,
    manifest
  );
  const schedules =
    selectedNames === null
      ? manifest.schedules
      : manifest.schedules.filter((schedule) =>
          selectedNames.has(schedule.name)
        );
  return { mode, schedules };
}

export function parseSandboxTemplateScheduleNameSelection(
  value: string | boolean | undefined,
  manifest: SandboxTemplateManifest
): Set<string> | null {
  if (value === undefined || value === true) {
    return null;
  }
  const raw = String(value).trim();
  if (!raw || raw === "true" || raw.toLowerCase() === "all") {
    return null;
  }
  if (raw.toLowerCase() === "none") {
    return new Set();
  }
  const known = new Set(manifest.schedules.map((schedule) => schedule.name));
  const selected = new Set(
    raw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  );
  for (const name of selected) {
    if (!known.has(name)) {
      throw new Error(`manifest schedule not found: ${name}`);
    }
  }
  return selected;
}

export function parseSandboxTemplateScheduleOverrides(
  manifest: SandboxTemplateManifest,
  options: Record<string, string | boolean>
): Map<string, SandboxTemplateScheduleOverride> {
  const raw =
    typeof options.scheduleOverrides === "string"
      ? options.scheduleOverrides
      : typeof options.scheduleOverride === "string"
      ? options.scheduleOverride
      : "";
  if (!raw.trim()) {
    return new Map();
  }
  const parsed = parseJsonOption(raw, "schedule-overrides");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      "schedule-overrides must be a JSON object keyed by schedule name"
    );
  }
  const known = new Set(manifest.schedules.map((schedule) => schedule.name));
  const out = new Map<string, SandboxTemplateScheduleOverride>();
  for (const [name, override] of Object.entries(parsed)) {
    if (!known.has(name)) {
      throw new Error(`schedule override target does not exist: ${name}`);
    }
    if (!override || typeof override !== "object" || Array.isArray(override)) {
      throw new Error(`schedule override for ${name} must be an object`);
    }
    out.set(name, override as SandboxTemplateScheduleOverride);
  }
  return out;
}

export function buildSandboxTemplateStartScheduleInput(params: {
  manifest: SandboxTemplateManifest;
  schedule: SandboxTemplateManifest["schedules"][number];
  override: SandboxTemplateScheduleOverride | undefined;
  mode: SandboxTemplateStartScheduleMode;
  sourceSandboxId: string;
  teamId: string;
  projectId: string;
}): SandboxScheduleCreateInput {
  const schedule = mergeSandboxTemplateScheduleOverride(
    params.schedule,
    params.override
  );
  const expression = sandboxTemplateScheduleExpression(schedule);
  return {
    sourceSandboxId: params.sourceSandboxId,
    ...(params.teamId ? { teamId: params.teamId } : {}),
    ...(params.projectId ? { projectId: params.projectId } : {}),
    name: schedule.name,
    ...(schedule.description ? { description: schedule.description } : {}),
    ...expression,
    ...(schedule.timezone ? { timezone: schedule.timezone } : {}),
    enabled:
      typeof params.override?.enabled === "boolean"
        ? params.override.enabled
        : params.mode === "enabled",
    ...(schedule.startAt ? { startAt: schedule.startAt } : {}),
    ...(schedule.endAt ? { endAt: schedule.endAt } : {}),
    ...(schedule.maxRuns !== undefined ? { maxRuns: schedule.maxRuns } : {}),
    runtimePolicy: schedule.runtimePolicy,
    target: sandboxTemplateScheduleCommandTarget(params.manifest, schedule),
    ...(schedule.budget ? { budget: schedule.budget } : {}),
    ...(schedule.resources ? { resources: schedule.resources } : {}),
    ...(schedule.quotas ? { quotas: schedule.quotas } : {}),
    ...(schedule.lifecycle ? { lifecycle: schedule.lifecycle } : {}),
    ...(schedule.retentionPolicy
      ? { retentionPolicy: schedule.retentionPolicy }
      : {}),
    ...(schedule.env ? { env: schedule.env } : {}),
    ...(schedule.integrationLeases
      ? {
          integrationLeases:
            schedule.integrationLeases as unknown as SandboxScheduleCreateInput["integrationLeases"],
        }
      : {}),
    metadata: {
      ...(schedule.metadata ?? {}),
      manifestScheduleName: schedule.name,
      source: "openpond-code-sandbox-template-start",
    },
    managementSource: "openpond.yaml",
    manifestPath: OPENPOND_MANIFEST_FILE_NAME,
  };
}

export function mergeSandboxTemplateScheduleOverride(
  schedule: SandboxTemplateManifest["schedules"][number],
  override: SandboxTemplateScheduleOverride | undefined
): SandboxTemplateManifest["schedules"][number] {
  if (!override) {
    return schedule;
  }
  return {
    ...schedule,
    ...override,
    target:
      schedule.target || override.target
        ? {
            ...(schedule.target ?? {}),
            ...(override.target ?? {}),
          }
        : undefined,
    metadata:
      schedule.metadata || override.metadata
        ? {
            ...(schedule.metadata ?? {}),
            ...(override.metadata ?? {}),
          }
        : undefined,
  } as SandboxTemplateManifest["schedules"][number];
}

export function sandboxTemplateScheduleExpression(
  schedule: SandboxTemplateManifest["schedules"][number]
): Pick<SandboxScheduleCreateInput, "scheduleType" | "scheduleExpression"> {
  if (schedule.scheduleExpression) {
    return {
      scheduleType: schedule.scheduleType ?? "cron",
      scheduleExpression: schedule.scheduleExpression,
    };
  }
  if (schedule.rate) {
    return {
      scheduleType: "rate",
      scheduleExpression: /^rate\(/i.test(schedule.rate)
        ? schedule.rate
        : `rate(${schedule.rate})`,
    };
  }
  if (schedule.once) {
    return {
      scheduleType: "once",
      scheduleExpression: /^at\(/i.test(schedule.once)
        ? schedule.once
        : `at(${schedule.once})`,
    };
  }
  return {
    scheduleType: "cron",
    scheduleExpression: schedule.cron ?? "",
  };
}

export function sandboxTemplateScheduleCommandTarget(
  manifest: SandboxTemplateManifest,
  schedule: SandboxTemplateManifest["schedules"][number]
): NonNullable<SandboxScheduleCreateInput["target"]> {
  const explicitCommand = schedule.command ?? schedule.target?.command ?? null;
  if (explicitCommand) {
    return {
      kind: "command",
      command: explicitCommand,
      requiresStart:
        schedule.requiresStart ?? schedule.target?.requiresStart ?? false,
    };
  }

  const targetKind = schedule.target?.kind ?? "action";
  if (targetKind === "start") {
    return {
      kind: "command",
      command: manifest.start.command,
      requiresStart:
        schedule.requiresStart ??
        schedule.target?.requiresStart ??
        manifest.start.requiresStart ??
        false,
    };
  }
  if (targetKind === "service") {
    const serviceName = schedule.target?.name ?? "";
    const service = manifest.services.find((item) => item.name === serviceName);
    if (!service) {
      throw new Error(`schedule service target does not exist: ${serviceName}`);
    }
    return {
      kind: "command",
      command: service.command,
      requiresStart:
        schedule.requiresStart ??
        schedule.target?.requiresStart ??
        service.requiresStart ??
        false,
    };
  }

  const actionName =
    schedule.actionName ??
    schedule.action ??
    schedule.target?.actionName ??
    (schedule.target?.kind === "action" ? schedule.target?.name : undefined);
  const action = manifest.actions.find((item) => item.name === actionName);
  if (!action) {
    throw new Error(
      `schedule action target does not exist: ${actionName ?? ""}`
    );
  }
  return {
    kind: "command",
    command: action.command,
    requiresStart:
      schedule.requiresStart ??
      schedule.target?.requiresStart ??
      action.requiresStart ??
      false,
  };
}
