import type {
  OpenPondProfileActionCatalogEntry,
  OpenPondProfileSetupGate,
  OpenPondProfileSetupRequirement,
} from "./local-profile-types.js";

type SetupRequirementSource = OpenPondProfileSetupRequirement["source"];

type BuildOpenPondProfileSetupGateInput = {
  actionCatalog: OpenPondProfileActionCatalogEntry[];
  sourceSetupRequirements?: Record<string, unknown>[];
  actionId?: string | null;
};

export class OpenPondProfileSetupRequiredError extends Error {
  readonly code = "agent_source_setup_required";
  readonly details: {
    error: "agent_source_setup_required";
    actionId: string;
    setupGate: OpenPondProfileSetupGate;
    missing: string[];
    blockingSetupRequirements: OpenPondProfileSetupRequirement[];
    setupRequirements: OpenPondProfileSetupRequirement[];
  };

  constructor(actionId: string, setupGate: OpenPondProfileSetupGate) {
    const labels = setupGate.blockingRequirements.map((requirement) => requirement.label);
    super(
      [
        "agent_source_setup_required",
        `Profile action ${actionId} has unresolved required setup.`,
        labels.length ? `Missing setup: ${labels.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    this.name = "OpenPondProfileSetupRequiredError";
    this.details = {
      error: "agent_source_setup_required",
      actionId,
      setupGate,
      missing: labels,
      blockingSetupRequirements: setupGate.blockingRequirements,
      setupRequirements: setupGate.requirements,
    };
  }
}

export function buildOpenPondProfileSetupGate(
  input: BuildOpenPondProfileSetupGateInput,
): OpenPondProfileSetupGate {
  const requirements = new Map<string, OpenPondProfileSetupRequirement>();

  for (const record of input.sourceSetupRequirements ?? []) {
    const sourceActionId = setupRequirementActionId(record);
    if (
      input.actionId &&
      sourceActionId &&
      sourceActionId !== input.actionId &&
      text(record.actionName) !== input.actionId &&
      text(record.sourceActionId) !== input.actionId
    ) {
      continue;
    }
    const requirement = setupRequirementFromRecord({
      record,
      source: "source_upload_metadata",
      actionId: sourceActionId,
    });
    if (requirement) requirements.set(requirement.ref, requirement);
  }

  for (const action of input.actionCatalog) {
    if (input.actionId && action.id !== input.actionId && action.name !== input.actionId) {
      continue;
    }
    for (const record of action.setupRequirements ?? []) {
      const requirement = setupRequirementFromRecord({
        record,
        source: "action_catalog",
        actionId: action.id,
      });
      if (requirement) requirements.set(requirement.ref, requirement);
    }
  }

  const allRequirements = Array.from(requirements.values());
  const blockingRequirements = allRequirements.filter((requirement) => requirement.blocking);
  const optionalMissingCount = allRequirements.filter(
    (requirement) => !requirement.required && !isReadyStatus(requirement.status),
  ).length;
  const readyCount = allRequirements.filter((requirement) => isReadyStatus(requirement.status)).length;
  return {
    status: gateStatus(blockingRequirements),
    requirementCount: allRequirements.length,
    blockingCount: blockingRequirements.length,
    optionalMissingCount,
    readyCount,
    requirements: allRequirements,
    blockingRequirements,
  };
}

export function assertOpenPondProfileActionReady(
  actionId: string,
  setupGate: OpenPondProfileSetupGate,
): void {
  if (setupGate.blockingRequirements.length > 0) {
    throw new OpenPondProfileSetupRequiredError(actionId, setupGate);
  }
}

export function formatOpenPondProfileSetupRequirement(
  requirement: OpenPondProfileSetupRequirement,
): string {
  const prefix = requirement.actionId ? `${requirement.actionId}: ` : "";
  const required = requirement.required ? "required" : "optional";
  return `${prefix}${requirement.label} (${required}, ${requirement.status})`;
}

function setupRequirementFromRecord(input: {
  record: Record<string, unknown>;
  source: SetupRequirementSource;
  actionId: string | null;
}): OpenPondProfileSetupRequirement | null {
  const source =
    input.source === "action_catalog" && text(input.record.source) === "source_upload_metadata"
      ? "source_upload_metadata"
      : input.source;
  const kind = text(input.record.kind) ?? text(input.record.type);
  const label =
    text(input.record.label) ??
    text(input.record.name) ??
    text(input.record.key) ??
    text(input.record.provider) ??
    text(input.record.tool) ??
    text(input.record.command) ??
    text(input.record.packageName) ??
    text(input.record.path) ??
    text(input.record.repo) ??
    text(input.record.url) ??
    text(input.record.id) ??
    kind ??
    "setup requirement";
  const required = input.record.required !== false;
  const status = setupStatus(input.record);
  const ref = [
    source,
    input.actionId ?? "source",
    kind ?? "requirement",
    label,
  ].join(":");
  return {
    ref,
    source,
    actionId: input.actionId,
    kind,
    label,
    status,
    required,
    blocking: required && !isReadyStatus(status),
  };
}

function setupRequirementActionId(record: Record<string, unknown>): string | null {
  return text(record.actionId) ?? text(record.sourceActionId) ?? text(record.actionName);
}

function setupStatus(record: Record<string, unknown>): string {
  const explicit = text(record.status) ?? text(record.state);
  if (explicit) {
    if (explicit === "satisfied" || explicit === "connected" || explicit === "provided") {
      return "ready";
    }
    return explicit;
  }
  if (typeof record.satisfied === "boolean") {
    return record.satisfied ? "ready" : "setup_required";
  }
  if (typeof record.ready === "boolean") {
    return record.ready ? "ready" : "setup_required";
  }
  return "setup_required";
}

function gateStatus(
  blockingRequirements: OpenPondProfileSetupRequirement[],
): OpenPondProfileSetupGate["status"] {
  if (blockingRequirements.length === 0) return "ready";
  return blockingRequirements.some((requirement) =>
    ["blocked", "unsupported", "unsupported_dependency", "stale"].includes(requirement.status),
  )
    ? "blocked"
    : "setup_required";
}

function isReadyStatus(status: string): boolean {
  return status === "ready" || status === "disabled";
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
