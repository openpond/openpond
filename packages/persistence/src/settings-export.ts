import { readConfig } from "./config.js";
import { type ConfigDocument } from "./config-schema.js";

/** Portable settings omit credentials, native browser state and machine-specific placement. */
export async function exportSettings(home: string) {
  const document = structuredClone((await readConfig(home)).document);
  const requiresRebinding: { path: string[]; reason: string }[] = [];
  function omit(parent: Record<string, unknown> | undefined, key: string, at: string[], reason: string) {
    if (parent && Object.hasOwn(parent, key)) { delete parent[key]; requiresRebinding.push({ path: [...at, key], reason }); }
  }
  for (const section of ["accounts", "providers"] as const) for (const [id, value] of Object.entries(document[section] ?? {})) omit(value, "credential", [section, id], "Reconnect or bind a credential on the destination device.");
  for (const section of ["accounts", "providers"] as const) for (const [id, value] of Object.entries(document[section] ?? {})) {
    for (const key of ["base_url", "api_base_url", "chat_api_base_url"]) {
      const endpoint = (value as Record<string, unknown>)[key];
      if (typeof endpoint !== "string") continue;
      try {
        const url = new URL(endpoint);
        if (url.username || url.password || [...url.searchParams.keys()].some((name) => /token|key|secret|password|credential|signature/i.test(name)) || url.hash) omit(value, key, [section, id], "Rebind this endpoint without embedded authentication data.");
      } catch { omit(value, key, [section, id], "Validate and bind this endpoint on the destination device."); }
    }
  }
  omit(document.storage, "datasets_dir", ["storage"], "Choose the dataset storage root on the destination device.");
  omit(document.projects, "new_project_directory", ["projects"], "Choose the local projects directory.");
  omit(document.personalization, "user_instructions", ["personalization"], "Transfer the instruction source and bind its destination path.");
  if (document.personalization?.active?.startsWith("custom:")) omit(document.personalization, "active", ["personalization"], "Transfer the selected custom personality Markdown before selecting it.");
  omit(document.defaults, "profile_ref", ["defaults"], "Install and select the Profile on the destination device.");
  for (const [id, language] of Object.entries(document.editor?.languages ?? {})) if (language.custom_command) {
    omit(language, "custom_command", ["editor", "languages", id], "Configure the local language-server command.");
    if (language.mode === "custom") delete language.mode;
  }
  return { schemaVersion: "openpond.settingsExport.v1" as const, config: document as ConfigDocument, requiresRebinding };
}
