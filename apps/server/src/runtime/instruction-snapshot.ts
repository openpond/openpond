import { createHash } from "node:crypto";
import {
  readOptionalFile, resolveConfigPath, PersistenceError, type ConfigDocument,
} from "@openpond/persistence";
import { PERSONALIZATION_TEMPLATES, DEFAULT_PERSONALIZATION_TEMPLATE_ID } from "@openpond/contracts";
import { resolveRepositoryInstructions, type RepositoryInstructionResolution } from "../openpond/repository-instructions.js";

export type InstructionSourceSnapshot = { role: "personality" | "user" | "repository"; path: string; hash: string };
export async function snapshotInstructions(home: string, config: ConfigDocument, repositoryCwd: string | null) {
  const sources: InstructionSourceSnapshot[] = [];
  const remember = (role: InstructionSourceSnapshot["role"], path: string, text: string) => { sources.push({ role, path, hash: createHash("sha256").update(text).digest("hex") }); };
  const active = config.personalization?.active ?? `builtin:${DEFAULT_PERSONALIZATION_TEMPLATE_ID}`;
  let personality = "";
  if (config.personalization?.mode !== "disabled") {
    if (active.startsWith("builtin:")) {
      const selected = PERSONALIZATION_TEMPLATES.find((entry) => entry.id === active.slice(8));
      if (!selected) throw unavailable(active);
      personality = selected.content; remember("personality", active, personality);
    } else {
      const file = resolveConfigPath(`instructions/personalities/${active.slice(7)}.md`, home);
      const text = await readOptionalFile(file);
      if (text === null) throw unavailable(file);
      personality = text; remember("personality", file, text);
    }
  }
  const userPath = resolveConfigPath(config.personalization?.user_instructions ?? "instructions/user.md", home);
  const user = await readOptionalFile(userPath);
  if (user === null && config.personalization?.user_instructions) throw unavailable(userPath);
  if (user !== null) {
    if (Buffer.byteLength(user) > 65_536) throw new PersistenceError({ code: "INVALID_INSTRUCTIONS", path: userPath, message: "User instructions exceed the 64 KiB limit.", action: "Shorten the configured user instruction file." });
    remember("user", userPath, user);
  }
  const repository: RepositoryInstructionResolution | null = repositoryCwd ? await resolveRepositoryInstructions(repositoryCwd) : null;
  for (const entry of repository?.sources ?? []) remember("repository", entry.absolutePath, entry.content);
  return { personality, userContext: user ? `Global user instruction source ${JSON.stringify(userPath)}:\n${user}\nEnd global user instruction source.` : "", repository, sources };
}
function unavailable(file: string): PersistenceError {
  return new PersistenceError({ code: "MISSING_INSTRUCTION_SOURCE", path: file, message: "A selected instruction source is unavailable.", action: "Restore that file or change its selector in configuration settings." });
}
