import {
  createGithubExtensionManager,
  loadOpenPondProfileState,
  type GithubExtensionManager,
} from "@openpond/cloud";
import { SHIPPED_OPENPOND_SKILL_NAMES } from "@openpond/contracts";

import { parseBooleanOption } from "./common/options";

type CliOptions = Record<string, string | boolean>;

export async function runOpenPondExtensionCommand(
  options: CliOptions,
  rest: string[],
  manager: GithubExtensionManager = createGithubExtensionManager({
    reservedSkillNames: async () => {
      const profile = await loadOpenPondProfileState();
      return [
        ...SHIPPED_OPENPOND_SKILL_NAMES,
        ...profile.skills.map((skill) => skill.name),
      ];
    },
  }),
): Promise<void> {
  const subcommand = rest[0]?.toLowerCase() || "list";
  const json = parseBooleanOption(options.json);
  if (subcommand === "list") {
    const catalog = await manager.list();
    if (catalog.error) throw new Error(catalog.error);
    printExtensionList(catalog.extensions, json);
    return;
  }
  if (subcommand === "add" || subcommand === "preview") {
    const source = requiredSource(rest[1], subcommand);
    const request = { source, ref: optionText(options.ref) };
    const result = subcommand === "preview"
      ? await manager.preview(request)
      : await manager.add(request);
    printExtension(result, json, subcommand === "preview" ? "Preview" : "Installed");
    return;
  }
  if (subcommand === "inspect") {
    printExtension(await manager.inspect(requiredSource(rest[1], subcommand)), json, "Installed");
    return;
  }
  if (subcommand === "update") {
    if (parseBooleanOption(options.all)) {
      const result = await manager.updateAll();
      if (json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Updated ${result.updated.length}; unchanged ${result.unchanged.length}; failed ${result.failed.length}.`);
        for (const failure of result.failed) console.log(`- ${failure.id}: ${failure.error}`);
      }
      if (result.failed.length > 0) process.exitCode = 1;
      return;
    }
    const source = requiredSource(rest[1], subcommand);
    const result = await manager.update({ source, ref: optionText(options.ref) });
    printExtension(result, json, "Updated");
    return;
  }
  if (subcommand === "remove") {
    const removed = await manager.remove(requiredSource(rest[1], subcommand));
    if (json) {
      console.log(JSON.stringify({ removed }, null, 2));
    } else {
      console.log(`Removed ${removed.owner}/${removed.repo} and ${removed.skills.length} skill(s).`);
    }
    return;
  }
  throw new Error(
    "usage: openpond extension <add|preview|list|inspect|update|remove> [owner/repo] [--ref <ref>] [--all] [--json]",
  );
}

function printExtension(
  extension: {
    owner: string;
    repo: string;
    requestedRef: string;
    resolvedCommit: string;
    skills: Array<{ name: string; description: string; resourceFiles: string[] }>;
  },
  json: boolean,
  verb: string,
): void {
  if (json) {
    console.log(JSON.stringify(extension, null, 2));
    return;
  }
  console.log(`${verb} ${extension.owner}/${extension.repo}@${extension.resolvedCommit.slice(0, 12)} (${extension.requestedRef}).`);
  for (const skill of extension.skills) {
    const resources = skill.resourceFiles.length > 0 ? `, ${skill.resourceFiles.length} resource(s)` : "";
    console.log(`- ${skill.name}${resources}: ${skill.description}`);
  }
}

function printExtensionList(
  extensions: Array<{
    owner: string;
    repo: string;
    resolvedCommit: string;
    validationStatus: string;
    skills: Array<{ name: string }>;
  }>,
  json: boolean,
): void {
  if (json) {
    console.log(JSON.stringify({ extensions }, null, 2));
    return;
  }
  if (extensions.length === 0) {
    console.log("No third-party extensions installed.");
    return;
  }
  console.log(`Third-party extensions (${extensions.length}):`);
  for (const extension of extensions) {
    console.log(
      `- ${extension.owner}/${extension.repo}@${extension.resolvedCommit.slice(0, 12)} · ${extension.skills.length} skill(s) · ${extension.validationStatus}`,
    );
  }
}

function requiredSource(value: string | undefined, subcommand: string): string {
  const source = value?.trim();
  if (source) return source;
  throw new Error(`usage: openpond extension ${subcommand} <owner/repo>`);
}

function optionText(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
