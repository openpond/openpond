import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function contentHash(value: unknown): string {
  return sha256(canonicalJson(value));
}
