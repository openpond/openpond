import { z } from "zod";
import { canonicalJson, ImmutableAssetRefSchema } from "./common.js";
import { sha256Hex } from "./sha256.js";

/** An opt-in generation language. Full output validation remains authoritative. */
export const StructuredSamplingSchemaDeclarationSchema = z.object({
  schemaVersion: z.literal("openpond.structuredSamplingSchema.v1"),
  validationSchemaHash: z.string().regex(/^[a-f0-9]{64}$/),
  schemaRef: ImmutableAssetRefSchema.refine(ref => ref.visibility === "policy"
    && ref.sizeBytes <= 128000 && ["application/json", "application/schema+json"].includes(ref.mediaType),
  "Sampling schemas must be bounded policy-visible JSON assets."),
  postValidationOnly: z.array(z.object({
    schemaPath: z.string().min(1).max(2000),
    keyword: z.literal("maxItems"),
    enforcement: z.literal("full_validation_only"),
  }).strict()).min(1).max(100),
}).strict();
export type StructuredSamplingSchemaDeclaration = z.infer<typeof StructuredSamplingSchemaDeclarationSchema>;
export const StructuredSamplingSchemaContractSchema = z.object({
  declaration: StructuredSamplingSchemaDeclarationSchema,
  schema: z.record(z.string(), z.unknown()),
  schemaHash: z.string().regex(/^[a-f0-9]{64}$/),
  schemaSource: z.string().max(128000),
}).strict();
export type StructuredSamplingSchemaContract = z.infer<typeof StructuredSamplingSchemaContractSchema>;

export function structuredSamplingSchemaDeclaration(metadata: Record<string, unknown> | undefined) {
  const value = metadata?.structuredSamplingSchema;
  return value === undefined ? undefined : StructuredSamplingSchemaDeclarationSchema.parse(value);
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const escape = (key: string) => key.replaceAll("~", "~0").replaceAll("/", "~1");
type FullSchema = { schema: Record<string, unknown>; schemaHash: string; schemaSource: string };

export function projectStructuredSamplingSchema(full: FullSchema, declarationInput: StructuredSamplingSchemaDeclaration) {
  const declaration = StructuredSamplingSchemaDeclarationSchema.parse(declarationInput);
  if (declaration.validationSchemaHash !== full.schemaHash) throw new Error("structured_sampling_validation_identity_changed");
  if (sha256Hex(full.schemaSource) !== full.schemaHash
    || canonicalJson(JSON.parse(full.schemaSource)) !== canonicalJson(full.schema)) throw new Error("structured_sampling_validation_source_changed");
  // JSONB can reorder an object copy. The immutable source bytes own grammar
  // property order; always derive from them rather than a transported object.
  const result = JSON.parse(full.schemaSource) as Record<string, unknown>;
  const targets = new Map<string, Record<string, unknown>>();
  function visit(schema: unknown, path: string, positive = true) {
    if (!object(schema)) return;
    if (schema.$ref !== undefined) throw new Error("structured_sampling_reference_unsupported");
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (positive && types.includes("array") && Number.isSafeInteger(schema.maxItems) && Number(schema.maxItems) >= 0) {
      targets.set(`${path}/maxItems`, schema);
    }
    // Traverse schema locations only. const/enum/default/examples are literal
    // JSON values and must never become assertion-removal targets.
    // v1 only weakens positive assertion contexts. In particular, weakening a
    // not/if/oneOf branch can instead exclude valid full-schema outputs. Local
    // definitions may be referenced in those contexts, so do not edit them.
    for (const key of ["properties", "$defs"]) if (object(schema[key])) {
      for (const [name, child] of Object.entries(schema[key])) visit(child, `${path}/${key}/${escape(name)}`, positive && key !== "$defs");
    }
    for (const key of ["items", "additionalProperties", "then", "else", "not", "if"]) {
      if (schema[key] !== undefined) visit(schema[key], `${path}/${key}`, positive && key !== "not" && key !== "if");
    }
    for (const key of ["allOf", "anyOf", "oneOf"]) if (Array.isArray(schema[key])) {
      schema[key].forEach((child, index) => visit(child, `${path}/${key}/${index}`, positive && key !== "oneOf"));
    }
  }
  visit(result, "");
  const seen = new Set<string>();
  for (const assertion of declaration.postValidationOnly) {
    const target = targets.get(assertion.schemaPath);
    if (!target || seen.has(assertion.schemaPath)) throw new Error("structured_sampling_assertion_path_invalid");
    seen.add(assertion.schemaPath);
    delete target.maxItems;
  }
  return result;
}

export function assertStructuredSamplingSchema(full: FullSchema, input: StructuredSamplingSchemaContract) {
  const sampling = StructuredSamplingSchemaContractSchema.parse(input);
  const derived = projectStructuredSamplingSchema(full, sampling.declaration);
  // Preserve property order: it is an input to the pinned grammar compiler.
  const expectedSource = JSON.stringify(derived);
  if (sampling.schemaSource !== expectedSource || canonicalJson(sampling.schema) !== canonicalJson(derived)
    || sha256Hex(expectedSource) !== sampling.schemaHash
    || sampling.schemaHash !== sampling.declaration.schemaRef.contentHash
    || new TextEncoder().encode(expectedSource).byteLength !== sampling.declaration.schemaRef.sizeBytes) {
    throw new Error("structured_sampling_schema_identity_changed");
  }
}

export function resolveStructuredSamplingSchema(full: FullSchema, declarationInput: StructuredSamplingSchemaDeclaration, bytes: Uint8Array): StructuredSamplingSchemaContract {
  const declaration = StructuredSamplingSchemaDeclarationSchema.parse(declarationInput);
  if (bytes.byteLength > 128000 || bytes.byteLength !== declaration.schemaRef.sizeBytes
    || sha256Hex(bytes) !== declaration.schemaRef.contentHash) throw new Error("structured_sampling_asset_mismatch");
  const schemaSource = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const sampling = { declaration, schema: JSON.parse(schemaSource) as Record<string, unknown>,
    schemaHash: declaration.schemaRef.contentHash, schemaSource };
  assertStructuredSamplingSchema(full, sampling);
  return sampling;
}

/** Bounded, model-visible submission limits retain their original values. */
export function structuredSamplingSchemaAssertions(full: FullSchema, sampling: StructuredSamplingSchemaContract) {
  assertStructuredSamplingSchema(full, sampling);
  const schema: unknown = JSON.parse(full.schemaSource);
  return sampling.declaration.postValidationOnly.map(assertion => {
    let value = schema;
    for (const part of assertion.schemaPath.slice(1).split("/")) {
      const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
      value = object(value) || Array.isArray(value) ? Reflect.get(value, key) : undefined;
    }
    return { ...assertion, value: value as number };
  });
}
