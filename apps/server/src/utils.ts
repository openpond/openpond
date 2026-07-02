import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeEvent } from "@openpond/contracts";
import { DEFAULT_HOST, DEFAULT_PORT } from "./constants.js";

export function now(): string {
  return new Date().toISOString();
}

export function textFromUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message || value.name;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function extractDelta(params: unknown): string {
  if (!params || typeof params !== "object") return "";
  const record = params as Record<string, unknown>;
  for (const key of ["delta", "text", "output", "chunk", "message"]) {
    if (typeof record[key] === "string") return record[key] as string;
  }
  if (record.delta && typeof record.delta === "object") return textFromUnknown(record.delta);
  return "";
}

export function event(input: Omit<RuntimeEvent, "id" | "timestamp">): RuntimeEvent {
  return {
    id: randomUUID(),
    timestamp: now(),
    ...input,
  };
}

export function parseListen(input: string): { host: string; port: number } {
  const value = input.replace(/^https?:\/\//, "");
  const [host, port] = value.split(":");
  return {
    host: host || DEFAULT_HOST,
    port: port ? Number.parseInt(port, 10) : DEFAULT_PORT,
  };
}

export function isCliEntrypoint(metaUrl: string): boolean {
  const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
  return entry === path.resolve(fileURLToPath(metaUrl));
}
