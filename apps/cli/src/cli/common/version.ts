import { readFileSync } from "node:fs";
import path from "node:path";

export function getInstalledCliVersion(): string {
  const candidatePaths = [
    "../../../package.json",
    "../../package.json",
    "../package.json",
    "./package.json",
    "../../../../package.json",
  ];
  for (const candidatePath of candidatePaths) {
    try {
      const packageJsonPath = new URL(candidatePath, import.meta.url);
      const raw = readFileSync(packageJsonPath, "utf-8");
      const parsed = JSON.parse(raw) as { version?: unknown };
      if (typeof parsed.version === "string") {
        return parsed.version;
      }
    } catch {
      // Keep looking; bundled CLIs may place package metadata beside the file.
    }
  }
  try {
    const raw = readFileSync(path.join(path.dirname(process.execPath), "package.json"), "utf-8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === "string") {
      return parsed.version;
    }
  } catch {
    // Standalone binaries may not have package metadata beside the executable.
  }
  return "unknown";
}

export function parseSemver(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  if (!match) return null;
  const major = Number.parseInt(match[1]!, 10);
  const minor = Number.parseInt(match[2]!, 10);
  const patch = Number.parseInt(match[3]!, 10);
  if (
    !Number.isFinite(major) ||
    !Number.isFinite(minor) ||
    !Number.isFinite(patch)
  ) {
    return null;
  }
  return [major, minor, patch];
}

export function compareSemver(left: string, right: string): number | null {
  const l = parseSemver(left);
  const r = parseSemver(right);
  if (!l || !r) return null;
  for (let i = 0; i < 3; i += 1) {
    if (l[i]! < r[i]!) return -1;
    if (l[i]! > r[i]!) return 1;
  }
  return 0;
}

export async function fetchLatestNpmVersion(
  packageName: string
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(
      `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`,
      { signal: controller.signal }
    );
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `npm registry request failed: ${response.status} ${text}`.trim()
      );
    }
    const payload = (await response.json().catch(() => ({}))) as {
      version?: unknown;
    };
    if (
      typeof payload.version !== "string" ||
      payload.version.trim().length === 0
    ) {
      throw new Error("npm registry payload missing version");
    }
    return payload.version.trim();
  } finally {
    clearTimeout(timer);
  }
}
