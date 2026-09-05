import { getStaticTOMLValue, parseTOML, type AST } from "toml-eslint-parser";
import type { ConfigOperation } from "./config-schema.js";
import { PersistenceError } from "./errors.js";

export function parseToml(text: string, filePath: string): { ast: AST.TOMLProgram; value: unknown } {
  try {
    const ast = parseTOML(text, { tomlVersion: "1.0" });
    const value = getStaticTOMLValue(ast);
    assertJsonValue(value);
    return { ast, value };
  } catch (error) {
    const location = error as { lineNumber?: number; column?: number };
    throw new PersistenceError({ code: "INVALID_CONFIG", path: filePath, message: "Configuration contains invalid TOML or an unsupported value.", line: location.lineNumber, column: location.column === undefined ? undefined : location.column + 1, action: "Open config.toml, correct the indicated value, and retry." }, { cause: error });
  }
}

function assertJsonValue(value: unknown): void {
  if (value instanceof Date || typeof value === "bigint" || typeof value === "number" && (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value))) throw new Error("Unsupported TOML value");
  if (value && typeof value === "object") for (const [key, entry] of Object.entries(value)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("Reserved key");
    assertJsonValue(entry);
  }
}

export function tomlValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value).replace(/\\u([0-9a-f]{4})/gi, "\\u$1");
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  if (isRecord(value)) return `{ ${Object.entries(value).filter(([, entry]) => entry !== undefined).map(([key, entry]) => `${tomlKey(key)} = ${tomlValue(entry)}`).join(", ")} }`;
  throw new Error("Configuration cannot contain null or unsupported values.");
}
const tomlKey = (key: string) => /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
const keyPath = (node: AST.TOMLKey) => node.keys.map((key) => key.type === "TOMLBare" ? key.name : key.value);
const samePath = (left: readonly (string | number)[], right: readonly string[]) => left.length === right.length && left.every((key, index) => key === right[index]);
const prefix = (left: readonly (string | number)[], right: readonly string[]) => left.length <= right.length && left.every((key, index) => key === right[index]);
export function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date); }

/** Edits value ranges only. Unrelated syntax and all comments survive a save. */
export function editToml(text: string, operations: ConfigOperation[], filePath: string): string {
  let result = text;
  for (const operation of operations) result = editOne(result, operation, filePath);
  parseToml(result, filePath);
  return result.endsWith("\n") ? result : `${result}\n`;
}

function editOne(text: string, operation: ConfigOperation, filePath: string): string {
  if (!operation.path.length || operation.path.some((part) => !part || ["__proto__", "prototype", "constructor"].includes(part))) throw new Error("Invalid configuration key path.");
  const { ast } = parseToml(text, filePath);
  const entries: { path: string[]; node: AST.TOMLKeyValue }[] = [];
  const tables: AST.TOMLTable[] = [];
  for (const node of ast.body[0].body) {
    if (node.type === "TOMLKeyValue") entries.push({ path: keyPath(node.key), node });
    else {
      tables.push(node);
      if (node.kind !== "standard") continue;
      for (const entry of node.body) entries.push({ path: [...node.resolvedKey.map(String), ...keyPath(entry.key)], node: entry });
    }
  }
  const exact = entries.find((entry) => samePath(entry.path, operation.path));
  if (exact) {
    const node = exact.node;
    if (operation.op === "set") return replace(text, node.value.range, preserveInnerComments(text, ast, node.value.range, tomlValue(operation.value)));
    const comments = ast.comments.filter((comment) => comment.range[0] >= node.range[0] && comment.range[1] <= node.range[1]).map((comment) => text.slice(...comment.range)).join("\n");
    return replace(text, node.range, comments);
  }
  const containing = entries.find((entry) => prefix(entry.path, operation.path));
  if (containing) {
    const value = structuredClone(getStaticTOMLValue(containing.node.value));
    if (!isRecord(value)) throw new Error("Cannot edit a key below a scalar or array.");
    applyObjectOperation(value, { ...operation, path: operation.path.slice(containing.path.length) });
    return replace(text, containing.node.value.range, preserveInnerComments(text, ast, containing.node.value.range, tomlValue(value)));
  }
  const descendants = entries.filter((entry) => prefix(operation.path, entry.path));
  const descendantTables = tables.filter((table) => prefix(operation.path, table.resolvedKey.map(String)));
  if (descendants.length || descendantTables.length) {
    const ranges = [...descendants.map((entry) => entry.node.range), ...descendantTables.map((table) => [table.range[0], table.key.range[1] + 1] as [number, number])];
    for (const range of ranges.sort((left, right) => right[0] - left[0])) {
      const comments = ast.comments.filter((comment) => comment.range[0] >= range[0] && comment.range[1] <= range[1]).map((comment) => text.slice(...comment.range)).join("\n");
      text = replace(text, range, comments);
    }
    return operation.op === "unset" ? text : editOne(text, operation, filePath);
  }
  if (operation.op === "unset") return text;
  if (isRecord(operation.value) && !("mode" in operation.value) && !("source" in operation.value) && !("provider_id" in operation.value)) {
    return `${text.replace(/\n?$/, "\n")}\n${renderTable(operation.value, operation.path)}`;
  }
  const table = tables.filter((entry) => entry.kind === "standard" && prefix(entry.resolvedKey, operation.path) && entry.resolvedKey.length < operation.path.length).sort((left, right) => right.resolvedKey.length - left.resolvedKey.length)[0];
  if (table) {
    const tail = operation.path.slice(table.resolvedKey.length).map(tomlKey).join(".");
    const nextTable = tables.find((entry) => entry.range[0] > table.range[0]);
    const offset = nextTable?.range[0] ?? text.length;
    return `${text.slice(0, offset).replace(/\n?$/, "\n")}${tail} = ${tomlValue(operation.value)}\n${text.slice(offset)}`;
  }
  if (operation.path.length === 1) {
    const offset = tables[0]?.range[0] ?? text.length;
    return `${text.slice(0, offset).replace(/\n?$/, "\n")}${tomlKey(operation.path[0]!)} = ${tomlValue(operation.value)}\n${text.slice(offset)}`;
  }
  const parent = operation.path.slice(0, -1).map(tomlKey).join(".");
  return `${text.replace(/\n?$/, "\n")}\n[${parent}]\n${tomlKey(operation.path.at(-1)!)} = ${tomlValue(operation.value)}\n`;
}

function replace(text: string, range: readonly [number, number], replacement: string): string { return text.slice(0, range[0]) + replacement + text.slice(range[1]); }
function preserveInnerComments(text: string, ast: AST.TOMLProgram, range: readonly [number, number], replacement: string): string {
  const comments = ast.comments.filter((comment) => comment.range[0] >= range[0] && comment.range[1] <= range[1]);
  if (comments.length) throw new PersistenceError({ code: "CONFIG_EDIT_REQUIRES_TEXT", path: "config.toml", message: "This value contains comments that cannot be preserved by a structured edit.", action: "Edit this value directly in the configuration file." });
  void text;
  return replacement;
}

export function applyObjectOperation(target: Record<string, unknown>, operation: ConfigOperation): void {
  let parent = target;
  for (const part of operation.path.slice(0, -1)) {
    if (["__proto__", "prototype", "constructor"].includes(part)) throw new Error("Reserved key");
    if (!isRecord(parent[part])) parent[part] = {};
    parent = parent[part] as Record<string, unknown>;
  }
  const key = operation.path.at(-1)!;
  if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("Reserved key");
  if (operation.op === "set") parent[key] = operation.value;
  else delete parent[key];
}

export function diffConfig(before: Record<string, unknown>, after: Record<string, unknown>, at: string[] = []): ConfigOperation[] {
  const operations: ConfigOperation[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const left = before[key], right = after[key];
    if (JSON.stringify(left) === JSON.stringify(right)) continue;
    const path = [...at, key];
    if (right === undefined) operations.push({ op: "unset", path });
    else if (isRecord(left) && isRecord(right) && !("mode" in right) && !("source" in right) && !("provider_id" in right)) operations.push(...diffConfig(left, right, path));
    else operations.push({ op: "set", path, value: right });
  }
  return operations;
}

function renderTable(value: Record<string, unknown>, at: string[]): string {
  const scalar: string[] = [], children: string[] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    if (isRecord(entry) && !("mode" in entry) && !("source" in entry) && !("provider_id" in entry)) children.push(renderTable(entry, [...at, key]));
    else scalar.push(`${tomlKey(key)} = ${tomlValue(entry)}`);
  }
  return [...(at.length ? [`[${at.map(tomlKey).join(".")}]`] : []), ...scalar].join("\n") + "\n" + (children.length ? "\n" + children.join("\n") : "");
}

export function serializeConfig(value: Record<string, unknown>): string {
  const text = renderTable(value, []);
  parseToml(text, "config.toml");
  return text;
}
