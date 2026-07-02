import { isRecord } from "./schema";

export function toYaml(value: unknown, indent = 0): string {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]`;
    return value.map((item) => `${pad}- ${formatYamlItem(item, indent + 2)}`).join("\n");
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return `${pad}{}`;
    return entries.map(([key, entry]) => {
      if (isRecord(entry) || Array.isArray(entry)) {
        return `${pad}${key}:\n${toYaml(entry, indent + 2)}`;
      }
      return `${pad}${key}: ${yamlScalar(entry)}`;
    }).join("\n");
  }
  return `${pad}${yamlScalar(value)}`;
}

function formatYamlItem(value: unknown, indent: number): string {
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{}";
    const [first, ...rest] = entries;
    const [firstKey, firstValue] = first!;
    const firstLine = isRecord(firstValue) || Array.isArray(firstValue)
      ? `${firstKey}:\n${toYaml(firstValue, indent + 2)}`
      : `${firstKey}: ${yamlScalar(firstValue)}`;
    const restLines = rest.map(([key, entry]) => {
      if (isRecord(entry) || Array.isArray(entry)) {
        return `${" ".repeat(indent)}${key}:\n${toYaml(entry, indent + 2)}`;
      }
      return `${" ".repeat(indent)}${key}: ${yamlScalar(entry)}`;
    });
    return [firstLine, ...restLines].join("\n");
  }
  if (Array.isArray(value)) return `\n${toYaml(value, indent)}`;
  return yamlScalar(value);
}

function yamlScalar(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const text = String(value);
  if (/^[a-zA-Z0-9_./:@-]+$/.test(text)) return text;
  return JSON.stringify(text);
}
