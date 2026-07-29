import { promises as fs } from "node:fs";
import path from "node:path";

export type AgentPackageOrigin = {
  versionId: string;
  digest: string | null;
  validationReceiptIds: string[];
  evalReceiptIds: string[];
};

export async function readAgentPackageOrigin(
  agentRootPath: string,
  manifestHash: string
): Promise<AgentPackageOrigin> {
  const originPath = path.join(
    agentRootPath,
    ".openpond",
    "agent-package-origin.json"
  );
  const origin = await fs
    .readFile(originPath, "utf8")
    .then((raw) => asRecord(JSON.parse(raw)))
    .catch((): Record<string, unknown> => ({}));
  const versionId = stringValue(origin.versionId);
  const digest = stringValue(origin.digest);
  if (
    versionId &&
    digest &&
    /^[a-f0-9]{64}$/.test(digest) &&
    versionId === `agent-${digest.slice(0, 20)}`
  ) {
    return {
      versionId,
      digest,
      validationReceiptIds: stringArray(origin.validationReceiptIds),
      evalReceiptIds: stringArray(origin.evalReceiptIds),
    };
  }
  return {
    versionId: `manifest-${manifestHash.slice(0, 20)}`,
    digest: null,
    validationReceiptIds: [],
    evalReceiptIds: [],
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [
        ...new Set(
          value.flatMap((entry) =>
            typeof entry === "string" && entry.trim() ? [entry.trim()] : []
          )
        ),
      ]
    : [];
}
