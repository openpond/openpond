export type RuntimeInventoryVerification = "sha256" | "darwin-code-signature";

export type RuntimeInventoryEntry = {
  path: string;
  bytes: number;
  sha256: string;
  verification: RuntimeInventoryVerification;
};

export type RuntimeInventory = {
  schemaVersion: 1;
  platform: NodeJS.Platform;
  arch: string;
  generatedAt: string;
  totalBytes: number;
  fileCount: number;
  files: RuntimeInventoryEntry[];
};

export function runtimeInventoryVerification(
  platform: NodeJS.Platform,
  relativePath: string,
): RuntimeInventoryVerification {
  if (platform !== "darwin") return "sha256";
  return relativePath.endsWith(".node") || relativePath.endsWith("/spawn-helper")
    ? "darwin-code-signature"
    : "sha256";
}
