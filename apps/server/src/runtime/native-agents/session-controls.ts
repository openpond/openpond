import type { AcpObject, AcpSessionResult } from "@openpond/agent-runtime/acp/types";

type Value = { value: string; name: string; description?: string };
export function acpSelectValues(option: AcpObject | undefined): Value[] {
  if (option?.type !== "select" || !Array.isArray(option.options)) return [];
  return option.options.flatMap(entry => {
    if (!entry || typeof entry !== "object") return [];
    const group = entry as AcpObject;
    return Array.isArray(group.options) ? group.options : [group];
  }).flatMap(entry => entry && typeof entry === "object" && typeof entry.value === "string" && typeof entry.name === "string" ? [entry as Value] : []);
}
export function acpCategoryOption(session: AcpSessionResult, category: string): AcpObject | undefined {
  return session.configOptions?.find(option => option.category === category && option.type === "select" && typeof option.id === "string" && typeof option.currentValue === "string");
}
export function acpSessionModels(session: AcpSessionResult): AcpSessionResult["models"] {
  const option = acpCategoryOption(session, "model");
  return option ? { currentModelId: option.currentValue as string, availableModels: acpSelectValues(option).map(value => ({ modelId: value.value, name: value.name, description: value.description })) } : session.models;
}
export function acpSessionModes(session: AcpSessionResult): AcpSessionResult["modes"] {
  const option = acpCategoryOption(session, "mode");
  return option ? { currentModeId: option.currentValue as string, availableModes: acpSelectValues(option).map(value => ({ id: value.value, name: value.name, description: value.description })) } : session.modes;
}
/** Keep UI catalogs uniform while preserving config IDs for actual ACP routing. */
export function acpSessionCatalog(session: AcpSessionResult): AcpSessionResult {
  return { ...session, models: acpSessionModels(session), modes: acpSessionModes(session) };
}
