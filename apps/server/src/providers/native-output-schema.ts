export const NATIVE_OUTPUT_SCHEMA_ENCODING_VERSION = "explicit-const-types-draft7-v1";
/** Codex's strict output format requires explicit primitive types even when
 * JSON Schema's const already constrains the value to that type. Preserve the
 * contract and annotations; never descend into const/default/example data. */
const maps = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"];
const arrays = ["allOf", "anyOf", "oneOf", "prefixItems"];
const singles = ["items", "additionalProperties", "unevaluatedProperties", "unevaluatedItems", "contains", "propertyNames", "not", "if", "then", "else", "contentSchema"];
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function node(value: unknown): unknown {
  if (!record(value)) return value;
  const result = { ...value };
  if (!Object.hasOwn(value, "type") && Object.hasOwn(value, "const")) {
    const constant = value.const;
    if (constant === null) result.type = "null";
    else if (["string", "boolean", "number"].includes(typeof constant)) result.type = typeof constant;
  }
  for (const key of maps) if (record(value[key])) result[key] = Object.fromEntries(Object.entries(value[key]).map(([name, schema]) => [name, node(schema)]));
  for (const key of arrays) if (Array.isArray(value[key])) result[key] = value[key].map(node);
  for (const key of singles) if (Object.hasOwn(value, key)) result[key] = key === "items" && Array.isArray(value[key]) ? value[key].map(node) : node(value[key]);
  return result;
}
export function codexOutputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return node(schema) as Record<string, unknown>;
}

const modernDialects = new Set(["https://json-schema.org/draft/2020-12/schema", "https://json-schema.org/draft/2019-09/schema"]);
const modernOnly = new Set(["$defs", "$dynamicRef", "$dynamicAnchor", "$recursiveRef", "$recursiveAnchor", "unevaluatedProperties", "unevaluatedItems", "dependentSchemas", "dependentRequired", "prefixItems", "minContains", "maxContains", "contentSchema", "dependencies"]);
/** Claude Code validates with Draft7. Only remove a newer dialect declaration
 * when its actual schema uses the shared vocabulary; never discard modern
 * constraints and thereby silently widen the allowed output. */
export function claudeOutputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (!modernDialects.has(String(schema.$schema))) return codexOutputSchema(schema);
  const inspect = (value: unknown): void => {
    if (!record(value)) return;
    for (const key of Object.keys(value)) if (modernOnly.has(key)) throw new Error(`Claude structured output does not support this schema dialect keyword: ${key}`);
    if (Object.hasOwn(value, "$schema") && !modernDialects.has(String(value.$schema))) throw new Error("Claude structured output has a mixed schema dialect.");
    for (const key of maps) if (record(value[key])) Object.values(value[key]).forEach(inspect);
    for (const key of arrays) if (Array.isArray(value[key])) value[key].forEach(inspect);
    for (const key of singles) if (Object.hasOwn(value, key)) { if (key === "items" && Array.isArray(value[key])) throw new Error("Claude structured output cannot reinterpret modern tuple items."); inspect(value[key]); }
  };
  inspect(schema);
  const strip = (value: unknown): unknown => {
    if (!record(value)) return value;
    const result = { ...value }; delete result.$schema;
    for (const key of maps) if (record(value[key])) result[key] = Object.fromEntries(Object.entries(value[key]).map(([name, item]) => [name, strip(item)]));
    for (const key of arrays) if (Array.isArray(value[key])) result[key] = value[key].map(strip);
    for (const key of singles) if (Object.hasOwn(value, key)) result[key] = strip(value[key]);
    return result;
  };
  return strip(codexOutputSchema(schema)) as Record<string, unknown>;
}
