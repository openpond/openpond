import { readFileSync } from "node:fs";

let bundledRuntimeVersion: string | null | undefined;

export function getBundledRuntimeVersion(): string {
  if (bundledRuntimeVersion !== undefined) return bundledRuntimeVersion ?? "openpond-code bundled";

  try {
    const packageJsonUrl = new URL("../package.json", import.meta.resolve("openpond"));
    const packageJson = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as { version?: unknown };
    bundledRuntimeVersion = typeof packageJson.version === "string" ? `openpond-code@${packageJson.version}` : null;
  } catch {
    bundledRuntimeVersion = null;
  }

  return bundledRuntimeVersion ?? "openpond-code bundled";
}
