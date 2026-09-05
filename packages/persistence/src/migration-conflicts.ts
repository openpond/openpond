import { z } from "zod";
import { readConfig } from "./config.js";
import { diffConfig, editToml, parseToml } from "./toml-edit.js";
import { atomicWriteFile, readOptionalFile } from "./private-file.js";
import { validateConfigDocument } from "./config-schema.js";
import { PersistenceError } from "./errors.js";

export const MigrationResolutionsSchema = z.array(z.strictObject({ path: z.array(z.string().min(1)).min(1), choice: z.enum(["imported", "existing"]) })).max(10_000);
export type MigrationResolutions = z.infer<typeof MigrationResolutionsSchema>;
export async function resolveMigrationTarget(targetHome: string, stage: string, resolutions: MigrationResolutions = []): Promise<void> {
  const target = await readConfig(targetHome), imported = await readConfig(stage);
  const differences = diffConfig(target.document, imported.document);
  const decisions = MigrationResolutionsSchema.parse(resolutions);
  const selected = new Map(decisions.map((entry) => [JSON.stringify(entry.path), entry.choice]));
  const unresolved = differences.filter((entry) => !selected.has(JSON.stringify(entry.path)));
  if (unresolved.length) throw new PersistenceError({ code: "MIGRATION_CONFLICT", path: target.path,
    message: `Existing configuration conflicts with ${unresolved.length} imported fields: ${unresolved.map((entry) => JSON.stringify(entry.path)).join(", ")}.`,
    action: "Preview the migration, choose imported or existing for each conflicting field, and supply the resolution map. Both source versions remain preserved." });
  const text = editToml(await readOptionalFile(target.path) ?? "schema_version = 1\n", differences.filter((entry) => selected.get(JSON.stringify(entry.path)) === "imported"), target.path);
  validateConfigDocument(parseToml(text, target.path).value);
  await atomicWriteFile(imported.path, text);
}
