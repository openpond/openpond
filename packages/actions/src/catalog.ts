import { isProjectActionDefinition } from "./define-action.js";
import { projectActionJsonSchema } from "./schema.js";
import type {
  ProjectActionCatalogEntry,
  ProjectActionDefinition,
  ProjectActionRegistry,
} from "./types.js";

export function collectProjectActions(modules: unknown[]): ProjectActionDefinition[] {
  const actions: ProjectActionDefinition[] = [];
  const seenObjects = new Set<unknown>();
  const visit = (value: unknown) => {
    if (seenObjects.has(value)) return;
    if (value && (typeof value === "object" || typeof value === "function")) seenObjects.add(value);
    if (isProjectActionDefinition(value)) {
      actions.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  modules.forEach(visit);
  const byId = new Map<string, ProjectActionDefinition>();
  for (const action of actions) {
    if (byId.has(action.id)) throw new Error(`Duplicate Project Action id: ${action.id}`);
    byId.set(action.id, action);
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function createProjectActionRegistry(
  actions: readonly ProjectActionDefinition[],
): ProjectActionRegistry {
  return {
    schemaVersion: "openpond.projectActionRegistry.v1",
    actions: actions.map(toCatalogEntry),
  };
}

function toCatalogEntry(action: ProjectActionDefinition): ProjectActionCatalogEntry {
  return {
    id: action.id,
    sourceActionId: action.id,
    name: action.id,
    label: action.label,
    description: action.description,
    visibility: "default",
    inputSchema: projectActionJsonSchema(action.inputSchema),
    outputSchema: projectActionJsonSchema(action.outputSchema),
    approvalPolicy: {
      ...action.approval,
      required: action.approval.mode === "always" || action.approval.mode === "sensitive" ||
        (action.approval.mode === "writes" && action.behavior === "write"),
      risk: action.behavior,
    },
    artifactPolicy: {
      outputArtifacts: [],
      persistRunSummary: true,
      persistTrace: true,
    },
    setupRequirements: [...action.setup],
    mcp: { enabled: false },
    schedulePolicy: { enabled: false, allowAdHoc: true },
    trace: { name: action.id, namespace: "project-actions" },
    implementation: {
      type: "openpond-project-action",
      actionId: action.id,
      behavior: action.behavior,
      timeoutMs: action.timeoutMs,
      concurrency: action.concurrency,
    },
    invokesModel: action.invokesModel,
  };
}
