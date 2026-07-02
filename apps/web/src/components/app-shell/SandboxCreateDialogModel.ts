import type { SandboxTemplateManifest, WorkspaceToolResult } from "@openpond/contracts";
import {
  SANDBOX_TEMPLATE_PREVIEW_PORT_MAX,
  SANDBOX_TEMPLATE_PREVIEW_PORT_MIN,
  sandboxTemplateExecutableEntries,
} from "@openpond/contracts";
import type {
  SandboxCreateDialogInput,
  SandboxEnvInput,
  SandboxEnvMappingSelection,
  SandboxFileInput,
  SandboxManifestModel,
  SandboxScalarInput,
  SandboxScheduleSelection,
  SandboxTemplateEntrypoint,
} from "./SandboxCreateDialogTypes";

export type {
  SandboxCreateDialogInput,
  SandboxEnvInput,
  SandboxEnvMappingSelection,
  SandboxFileInput,
  SandboxFileUploadSelection,
  SandboxManifestModel,
  SandboxScalarInput,
  SandboxScheduleSelection,
  SandboxTemplateEntrypoint,
} from "./SandboxCreateDialogTypes";

export function previewUrlFromWorkspaceToolResult(result: WorkspaceToolResult | null): string | null {
  const data = asRecord(result?.data);
  const preview = asRecord(data.preview);
  const url = typeof preview.url === "string" ? preview.url.trim() : "";
  return url || null;
}

export function openSandboxPreviewPopup(): Window | null {
  const previewWindow = window.open("", "_blank");
  if (!previewWindow) return null;
  previewWindow.document.write(
    '<!doctype html><title>Opening sandbox preview</title><body style="margin:0;background:#05070a;color:#f5f5f4;font:14px system-ui,sans-serif;display:grid;place-items:center;height:100vh;">Opening sandbox preview...</body>'
  );
  previewWindow.document.close();
  return previewWindow;
}

export function finishSandboxPreviewPopup(previewWindow: Window | null, previewUrl: string | null): void {
  if (!previewUrl) {
    previewWindow?.close();
    return;
  }
  if (previewWindow) {
    previewWindow.opener = null;
    previewWindow.location.href = previewUrl;
    return;
  }
  window.open(previewUrl, "_blank", "noopener,noreferrer");
}

export function buildSandboxManifestModel(manifest: SandboxTemplateManifest | null | undefined): SandboxManifestModel {
  const entrypoints = normalizeEntrypoints(manifest);
  const resources = normalizeResources(asRecord(manifest?.resources));
  const schema = asRecord(asRecord(manifest?.inputs).schema);
  const properties = asRecord(schema.properties);
  const required = new Set(normalizeStringArray(schema.required));
  const scalarInputs: SandboxScalarInput[] = [];
  const fileInputs: SandboxFileInput[] = [];
  for (const [name, rawProperty] of Object.entries(properties)) {
    const property = asRecord(rawProperty);
    const upload = asRecord(property["x-openpond-upload"] ?? property.xOpenPondUpload);
    const type = typeof property.type === "string" ? property.type : "string";
    const items = asRecord(property.items);
    const targetNames = inputTargetNames(property, upload);
    const isFile =
      property.format === "file" ||
      upload.enabled === true ||
      (type === "array" && items.format === "file");
    const label = typeof property.title === "string" && property.title.trim() ? property.title.trim() : labelFromName(name);
    if (isFile) {
      fileInputs.push({
        name,
        label,
        required: required.has(name),
        multiple: type === "array" || upload.multiple === true,
        accept: uploadAccept(upload, property),
        targetPath: uploadTargetPath(upload, name),
        targetNames,
      });
      continue;
    }
    if (type === "string" || type === "number" || type === "integer" || type === "boolean") {
      scalarInputs.push({
        name,
        label,
        required: required.has(name),
        type,
        defaultValue: typeof property.default === "string" || typeof property.default === "number" || typeof property.default === "boolean"
          ? String(property.default)
          : "",
        targetNames,
      });
    }
  }
  return {
    entrypoints,
    scalarInputs,
    fileInputs,
    envInputs: normalizeEnvInputs(manifest),
    resources,
    volumes: normalizeVolumes(manifest, fileInputs),
    schedules: normalizeSchedules(manifest),
  };
}

export function filterSandboxInputsForTarget<T extends { targetNames: string[] | null }>(
  inputs: T[],
  targetName: string,
): T[] {
  const normalizedTarget = targetName.trim();
  return inputs.filter((input) => {
    if (!input.targetNames || input.targetNames.length === 0) return true;
    return input.targetNames.includes(normalizedTarget);
  });
}

function normalizeEntrypoints(manifest: SandboxTemplateManifest | null | undefined): SandboxTemplateEntrypoint[] {
  if (!manifest) return [];
  return sandboxTemplateExecutableEntries(manifest).flatMap((entrypoint) => {
    if (entrypoint.kind === "action") return [];
    const name = entrypoint.name.trim();
    const command = entrypoint.command.trim();
    const timeoutSeconds = positiveInteger(entrypoint.timeoutSeconds);
    const ports = entrypoint.ports.flatMap((port) => {
      const portNumber = positiveInteger(port.port);
      if (!portNumber) return [];
      return [
        {
          port: portNumber,
          label: typeof port.label === "string" && port.label.trim() ? port.label.trim() : "web",
          access: port.access === "public" ? ("public" as const) : ("private" as const),
          path: typeof port.path === "string" && port.path.trim() ? port.path.trim() : "/",
        },
      ];
    });
    return name && command ? [{ name, command, timeoutSeconds, ports }] : [];
  });
}

function normalizeResources(resources: Record<string, unknown>): SandboxManifestModel["resources"] {
  return {
    cpu: positiveNumber(resources.cpu) ?? 1,
    memoryGb: positiveNumber(resources.memoryGb) ?? 1,
    diskGb: positiveNumber(resources.diskGb) ?? 8,
  };
}

function normalizeVolumes(
  manifest: SandboxTemplateManifest | null | undefined,
  fileInputs: SandboxFileInput[],
): SandboxManifestModel["volumes"] {
  const volumes = Array.isArray(manifest?.volumes) ? manifest.volumes : [];
  if (volumes.length > 0) {
    return volumes.map((volume, index) => {
      const fallbackName = index === 0 ? "volume" : `volume-${index + 1}`;
      const name = typeof volume.name === "string" && volume.name.trim() ? volume.name.trim() : fallbackName;
      return {
        name,
        mountPath: typeof volume.mountPath === "string" && volume.mountPath.trim() ? volume.mountPath.trim() : `/workspace/volumes/${name}`,
        ...(positiveInteger(volume.storageGb) ? { storageGb: positiveInteger(volume.storageGb) ?? undefined } : {}),
        deleteOnSandboxDelete: volume.deleteOnSandboxDelete === true,
      };
    });
  }
  const firstVolumeUpload = fileInputs.find((input) => input.targetPath.startsWith("volumes/"));
  if (!firstVolumeUpload) return [];
  const [, name = "volume"] = firstVolumeUpload.targetPath.split("/");
  return [{
    name,
    mountPath: `/workspace/volumes/${name}`,
    storageGb: 8,
    deleteOnSandboxDelete: false,
  }];
}

function normalizeEnvInputs(manifest: SandboxTemplateManifest | null | undefined): SandboxEnvInput[] {
  const env = Array.isArray(manifest?.inputs.env) ? manifest.inputs.env : [];
  return env.flatMap((input) => {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name) return [];
    return [
      {
        name,
        required: input.required === true,
        secret: input.secret !== false,
        description: typeof input.description === "string" ? input.description.trim() : "",
      },
    ];
  });
}

function normalizeSchedules(
  manifest: SandboxTemplateManifest | null | undefined,
): SandboxScheduleSelection[] {
  if (!manifest?.schedules?.length) return [];
  return manifest.schedules.flatMap((schedule) => {
    const name = typeof schedule.name === "string" ? schedule.name.trim() : "";
    const expression = scheduleExpression(schedule);
    if (!name || !expression.scheduleExpression) return [];
    try {
      return [
        {
          name,
          ...(typeof schedule.description === "string" && schedule.description.trim()
            ? { description: schedule.description.trim() }
            : {}),
          enabled: false,
          ...expression,
          ...(typeof schedule.timezone === "string" && schedule.timezone.trim()
            ? { timezone: schedule.timezone.trim() }
            : {}),
          ...(typeof schedule.startAt === "string" && schedule.startAt.trim()
            ? { startAt: schedule.startAt.trim() }
            : {}),
          ...(typeof schedule.endAt === "string" && schedule.endAt.trim()
            ? { endAt: schedule.endAt.trim() }
            : {}),
          ...(typeof schedule.maxRuns === "number" &&
          Number.isInteger(schedule.maxRuns) &&
          schedule.maxRuns > 0
            ? { maxRuns: schedule.maxRuns }
            : {}),
          runtimePolicy: schedule.runtimePolicy,
          target: scheduleCommandTarget(manifest, schedule),
          ...(schedule.budget ? { budget: schedule.budget } : {}),
          ...(schedule.resources ? { resources: schedule.resources } : {}),
          ...(schedule.quotas ? { quotas: schedule.quotas } : {}),
          ...(schedule.lifecycle ? { lifecycle: schedule.lifecycle } : {}),
          ...(schedule.retentionPolicy ? { retentionPolicy: schedule.retentionPolicy } : {}),
          ...(schedule.env ? { env: schedule.env } : {}),
          ...(schedule.integrationLeases ? { integrationLeases: schedule.integrationLeases } : {}),
          metadata: {
            ...(asRecord(schedule.metadata)),
            manifestScheduleName: name,
            source: "openpond-app-sandbox-template-start",
          },
        },
      ];
    } catch {
      return [];
    }
  });
}

function scheduleExpression(
  schedule: SandboxTemplateManifest["schedules"][number],
): Pick<SandboxScheduleSelection, "scheduleType" | "scheduleExpression"> {
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

function scheduleCommandTarget(
  manifest: SandboxTemplateManifest,
  schedule: SandboxTemplateManifest["schedules"][number],
): SandboxScheduleSelection["target"] {
  const explicitCommand = schedule.command ?? schedule.target?.command ?? null;
  if (explicitCommand) {
    return {
      kind: "command",
      command: explicitCommand,
      requiresStart: schedule.requiresStart ?? schedule.target?.requiresStart ?? false,
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
    if (!service) throw new Error("schedule_service_target_missing");
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
  if (!action) throw new Error("schedule_action_target_missing");
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

export function buildSandboxEnvMappings(
  inputs: SandboxEnvInput[],
  secretRefs: Record<string, string>,
): SandboxEnvMappingSelection[] {
  return inputs.flatMap((input) => {
    const secretRef = (secretRefs[input.name] ?? "").trim();
    return secretRef ? [{ name: input.name, secretRef }] : [];
  });
}

export function buildScalarParams(inputs: SandboxScalarInput[], values: Record<string, string>): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const input of inputs) {
    const value = values[input.name] ?? "";
    if (!value.trim() && !input.required) continue;
    if (input.type === "boolean") {
      params[input.name] = value === "true";
    } else if (input.type === "number" || input.type === "integer") {
      const numberValue = Number(value);
      if (Number.isFinite(numberValue)) {
        params[input.name] = input.type === "integer" ? Math.trunc(numberValue) : numberValue;
      }
    } else {
      params[input.name] = value;
    }
  }
  return params;
}

function inputTargetNames(property: Record<string, unknown>, upload: Record<string, unknown>): string[] | null {
  const raw =
    property["x-openpond-targets"] ??
    property.xOpenPondTargets ??
    upload.targets ??
    upload.actions;
  const values = normalizeStringArray(raw)
    .map((value) => value.trim())
    .filter(Boolean);
  return values.length > 0 ? [...new Set(values)] : null;
}

function uploadAccept(upload: Record<string, unknown>, property: Record<string, unknown>): string {
  if (typeof upload.accept === "string") return upload.accept.trim();
  if (Array.isArray(upload.accept)) return upload.accept.filter((item): item is string => typeof item === "string").join(",");
  if (typeof property.accept === "string") return property.accept.trim();
  return "";
}

function uploadTargetPath(upload: Record<string, unknown>, name: string): string {
  const raw =
    typeof upload.targetPath === "string" && upload.targetPath.trim()
      ? upload.targetPath.trim()
      : typeof upload.path === "string" && upload.path.trim()
        ? upload.path.trim()
        : `uploads/${name}`;
  return raw.replace(/^\/+/, "").replace(/^workspace\//, "").replace(/\/+$/, "");
}

function positiveNumber(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : null;
}

function positiveInteger(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isInteger(numberValue) && numberValue > 0 ? numberValue : null;
}

export function mergeFirstVolume(
  declared: SandboxCreateDialogInput["volumes"],
  first: SandboxCreateDialogInput["volumes"][number],
): SandboxCreateDialogInput["volumes"] {
  return [first, ...declared.slice(1)];
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function labelFromName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
