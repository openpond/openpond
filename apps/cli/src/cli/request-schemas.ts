import { z } from "zod";

/** Offline introspection of the installed public SDK, never account discovery
 * or an API request. Runtime commands retain their original strict parsers. */
export async function runRequestSchemaCommand(namespace: "training" | "learning", name?: string): Promise<void> {
  const exports = namespace === "training" ? await import("openpond-sdk/training") : await import("openpond-sdk/learning");
  const schemas = Object.entries(exports).filter(([key, value]) => key.endsWith("Schema") && value && typeof value === "object" && "safeParse" in value);
  if (!name) {
    console.log(JSON.stringify({ namespace, schemas: schemas.map(([key]) => key).sort() }, null, 2));
    return;
  }
  const key = name.endsWith("Schema") ? name : `${name}Schema`;
  const schema = schemas.find(([candidate]) => candidate === key)?.[1];
  if (!schema) throw new Error(`Unknown ${namespace} schema. Run ${namespace} schema to list installed public schemas.`);
  console.log(JSON.stringify({ namespace, name: key, schema: z.toJSONSchema(schema as z.ZodType, { io: "input", unrepresentable: "any" }) }, null, 2));
}
