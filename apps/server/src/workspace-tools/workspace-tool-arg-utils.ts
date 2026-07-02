export function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
  return value;
}

export function stringValueArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
}

export function stringArrayArg(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${key} must be an array of strings`);
  }
  return value;
}

export function optionalStringArrayArg(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${key} must be a string or an array of strings`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

export function optionalNumberArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error(`${key} must be a number`);
}

export function stringRecordArg(args: Record<string, unknown>, key: string): Record<string, string> {
  const value = args[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${key} must be an object of file paths to content strings`);
  }
  const result: Record<string, string> = {};
  for (const [filePath, content] of Object.entries(value)) {
    if (typeof content !== "string") throw new Error(`${key}.${filePath} must be a string`);
    result[filePath] = content;
  }
  return result;
}

export function recordArg(args: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = args[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${key} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function optionalRecordArg(args: Record<string, unknown>, key: string): Record<string, string> | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${key} must be an object`);
  }
  const result: Record<string, string> = {};
  for (const [name, child] of Object.entries(value)) {
    if (typeof child !== "string") throw new Error(`${key}.${name} must be a string`);
    result[name] = child;
  }
  return result;
}

export function optionalToolMethodArg(args: Record<string, unknown>): "GET" | "POST" | "PUT" | "DELETE" {
  const value = args.method;
  if (value === undefined) return "POST";
  if (typeof value !== "string") throw new Error("method must be a string");
  const method = value.toUpperCase();
  if (method === "GET" || method === "POST" || method === "PUT" || method === "DELETE") return method;
  throw new Error("method must be GET, POST, PUT, or DELETE");
}
