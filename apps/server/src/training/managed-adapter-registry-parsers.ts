import type {
  ManagedRegistryArtifact,
  ManagedRegistryBaseProfile,
  ManagedRegistryCapabilities,
  ManagedRegistryDeployment,
} from "./managed-adapter-registry-client.js";

export function registryArtifacts(value: unknown): ManagedRegistryArtifact[] {
  return Array.isArray(value) ? value.map(requiredRegistryArtifact) : [];
}

export function requiredRegistryCapabilities(
  value: unknown
): ManagedRegistryCapabilities {
  if (
    !isRecord(value) ||
    value.schemaVersion !== "openpond.modelAdapterPlatformCapabilities.v1" ||
    !isRecord(value.contractVersions) ||
    value.contractVersions.baseModelProfile !==
      "openpond.baseModelProfile.v2" ||
    !isRecord(value.lifecycle) ||
    value.lifecycle.policyOwner !== "sandbox" ||
    !Array.isArray(value.baseProfiles)
  ) {
    throw new Error(
      "Managed adapter registry returned incompatible platform capabilities."
    );
  }
  const baseProfiles = value.baseProfiles.map((profile) => {
    if (
      !isRecord(profile) ||
      typeof profile.id !== "string" ||
      typeof profile.repository !== "string" ||
      typeof profile.revision !== "string" ||
      typeof profile.tokenizerRevision !== "string" ||
      typeof profile.chatTemplateHash !== "string" ||
      !["draft", "supported", "retired"].includes(String(profile.status))
    ) {
      throw new Error(
        "Managed adapter registry returned an invalid base profile capability."
      );
    }
    return {
      id: profile.id,
      repository: profile.repository,
      revision: profile.revision,
      tokenizerRevision: profile.tokenizerRevision,
      chatTemplateHash: profile.chatTemplateHash,
      status: profile.status as ManagedRegistryBaseProfile["status"],
    };
  });
  return {
    schemaVersion: value.schemaVersion,
    baseModelProfileContractVersion: value.contractVersions.baseModelProfile,
    baseProfiles,
    lifecyclePolicyOwner: value.lifecycle.policyOwner,
  };
}

export function registryDeployments(
  value: unknown
): ManagedRegistryDeployment[] {
  if (!Array.isArray(value)) return [];
  return value.map(requiredRegistryDeployment);
}

export function requiredRegistryArtifact(
  value: unknown
): ManagedRegistryArtifact {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.source !== "string" ||
    typeof value.sourceRef !== "string" ||
    typeof value.state !== "string" ||
    typeof value.promotable !== "boolean" ||
    typeof value.customerBindingAllowed !== "boolean"
  ) {
    throw new Error("Managed adapter registry returned an invalid artifact.");
  }
  return {
    id: value.id,
    source: value.source,
    sourceRef: value.sourceRef,
    state: value.state,
    promotable: value.promotable,
    customerBindingAllowed: value.customerBindingAllowed,
    contentHash:
      typeof value.contentHash === "string" ? value.contentHash : null,
    baseProfileId:
      typeof value.baseProfileId === "string" ? value.baseProfileId : null,
  };
}

function requiredRegistryDeployment(item: unknown): ManagedRegistryDeployment {
  if (
    !isRecord(item) ||
    typeof item.id !== "string" ||
    typeof item.artifactId !== "string" ||
    typeof item.state !== "string"
  ) {
    throw new Error("Managed adapter registry returned an invalid deployment.");
  }
  return {
    id: item.id,
    artifactId: item.artifactId,
    state: item.state,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
