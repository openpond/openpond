/** Explain public schema relationships without changing validation or data. */
type Schema = Record<string, unknown>;
type SchemaError = {
  instancePath: string;
  schemaPath: string;
  keyword: string;
  params: Record<string, unknown>;
  message?: string;
};
const object = (value: unknown): value is Schema => !!value && typeof value === "object" && !Array.isArray(value);
const escape = (value: string) => value.replaceAll("~", "~0").replaceAll("/", "~1");
const unescape = (value: string) => value.replaceAll("~1", "/").replaceAll("~0", "~");
const label = (path: string) => path || "/";
function literal(value: unknown): string {
  const text = JSON.stringify(value);
  return text && text.length <= 160 ? text : "the value declared in the public schema";
}
function at(root: unknown, parts: string[]): unknown {
  let value = root;
  for (const encoded of parts) {
    const key = unescape(encoded);
    if ((!object(value) && !Array.isArray(value)) || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
function resolve(schema: unknown, root: Schema, depth = 0): Schema | null {
  if (!object(schema) || depth > 20) return null;
  if (typeof schema.$ref === "string" && schema.$ref.startsWith("#/")) {
    return resolve(at(root, schema.$ref.slice(2).split("/")), root, depth + 1);
  }
  return schema;
}
function describe(schema: unknown, path: string, data: unknown, root: Schema, depth = 0): string | null {
  const rule = resolve(schema, root);
  if (!rule || depth > 6) return null;
  const where = label(path);
  if (Object.hasOwn(rule, "const")) return `${where} must equal ${literal(rule.const)}`;
  if (Array.isArray(rule.enum) && rule.enum.length <= 12) return `${where} must be one of ${literal(rule.enum)}`;
  if (Array.isArray(data)) {
    if (rule.maxItems === 0) return `${where} must be an empty array`;
    // JSON Schema's not(items(not(predicate))) expresses at least one match.
    const negated = object(rule.not) ? rule.not : null;
    const every = negated && object(negated.items) ? negated.items : null;
    const predicate = every && object(every.not) ? resolve(every.not, root) : null;
    const required = predicate?.required;
    if (predicate && object(predicate.properties) && Array.isArray(required)) {
      const fields = Object.entries(predicate.properties);
      if (fields.length && fields.every(([key, value]) => object(value) && Object.hasOwn(value, "const")
          && required.includes(key))) {
        const match = Object.fromEntries(fields.map(([key, value]) => [key, (value as Schema).const]));
        return `${where} must contain at least one item matching ${literal(match)}`;
      }
    }
    if (typeof rule.maxItems === "number") return `${where} must contain at most ${rule.maxItems} items`;
    if (typeof rule.minItems === "number") return `${where} must contain at least ${rule.minItems} items`;
  }
  if (object(rule.properties) && object(data)) {
    const parts = Object.entries(rule.properties).flatMap(([key, child]) => {
      if (!Object.hasOwn(data, key)) return [];
      const message = describe(child, path + "/" + escape(key), data[key], root, depth + 1);
      return message ? [message] : [];
    });
    if (parts.length) return parts.slice(0, 4).join("; ");
  }
  if (Array.isArray(rule.required) && object(data)) {
    const missing = rule.required.filter((key): key is string => typeof key === "string" && !Object.hasOwn(data, key));
    if (missing.length) return `${where} must include ${missing.slice(0, 4).map(literal).join(", ")}`;
  }
  return null;
}

export function structuredOutputDiagnostic(schema: Schema, data: unknown, error: SchemaError) {
  const path = error.instancePath + (error.keyword === "required"
    ? "/" + escape(String(error.params.missingProperty)) : "");
  const parts = error.schemaPath.startsWith("#/") ? error.schemaPath.slice(2).split("/") : [];
  let message = error.message ?? "Schema assertion failed";
  const owner = at(schema, parts.slice(0, -1));
  const requirement = describe(owner, error.instancePath,
    at(data, error.instancePath ? error.instancePath.slice(1).split("/") : []), schema);
  // Resolve the nearest enclosing conditional in the PUBLIC schema. No
  // expected answer or private grader input participates in this explanation.
  for (let index = parts.length - 1; index >= 0; index--) {
    if (parts[index] !== "then" && parts[index] !== "else") continue;
    const conditional = at(schema, parts.slice(0, index));
    if (!object(conditional) || !object(conditional.if)) continue;
    // A nested condition's data location is the prefix preceding any
    // properties/items descent in its schema location, not always the root.
    const instance = error.instancePath ? error.instancePath.slice(1).split("/") : [];
    const suffix = parts.slice(index + 1);
    const descents = suffix.filter((part, offset) => offset > 0 && suffix[offset - 1] === "properties"
      || part === "items" && suffix[offset - 1] !== "properties").length;
    const parent = descents <= instance.length ? instance.slice(0, instance.length - descents) : [];
    const parentPath = parent.length ? "/" + parent.join("/") : "";
    const condition = describe(conditional.if, parentPath, at(data, parent), schema);
    if (condition && requirement) {
      const observed = condition.replaceAll(" must be ", " is ").replaceAll(" must equal ", " equals ")
        .replaceAll(" must contain ", " contains ").replaceAll(" must include ", " includes ");
      message = `${parts[index] === "then" ? "When" : "When the following condition does not hold:"} ${observed}, ${requirement}.`;
    }
    break;
  }
  if (message === error.message && requirement && ["not", "enum", "const", "minItems", "maxItems"].includes(error.keyword)) {
    message = requirement + ".";
  }
  return { path, message, keyword: error.keyword, schemaPath: error.schemaPath };
}
