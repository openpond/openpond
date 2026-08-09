import path from "node:path";

export function executableSearchPath(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") return environment.PATH ?? "";

  const userHome = environment.HOME?.trim();
  const preferred = [
    userHome ? path.join(userHome, ".local", "bin") : null,
    userHome ? path.join(userHome, ".bun", "bin") : null,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  const inherited = (environment.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean);

  return Array.from(
    new Set([...preferred.filter((entry): entry is string => Boolean(entry)), ...inherited]),
  ).join(path.delimiter);
}
