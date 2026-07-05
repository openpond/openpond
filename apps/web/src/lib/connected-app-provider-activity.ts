import {
  connectedAppBundleByProvider,
  normalizeConnectedAppProviderFamilyId,
  type RuntimeEvent,
} from "@openpond/contracts";
import { asRecord, stringValue } from "./chat-message-utils";

export type ConnectedAppProviderActivityRow = {
  id: string;
  label: string;
  content: string;
  timestamp: string;
  state: "running" | "completed" | "failed" | "pending" | "unknown";
};

export function connectedAppProviderActivityRows(
  events: RuntimeEvent[],
  limit = 8,
): ConnectedAppProviderActivityRow[] {
  const rows = events
    .map(connectedAppProviderActivityRow)
    .filter((row): row is ConnectedAppProviderActivityRow => Boolean(row));
  return rows.slice(Math.max(0, rows.length - limit));
}

export function connectedAppProviderActivityRow(
  item: RuntimeEvent,
): ConnectedAppProviderActivityRow | null {
  const label = connectedAppToolActivityLabel(item);
  if (!label) return null;
  return {
    id: item.id,
    label,
    content: connectedAppToolActivityContent(item) ?? label,
    timestamp: item.timestamp,
    state: connectedAppActivityState(item),
  };
}

export function connectedAppToolActivityLabel(item: RuntimeEvent): string | null {
  if (item.name !== "tool.started" && item.name !== "tool.completed") return null;
  const action = item.action;
  if (
    action !== "connected_app_search" &&
    action !== "connected_app_read" &&
    action !== "connected_app_write"
  ) {
    return null;
  }
  const provider = connectedAppProviderLabel(item);
  const failed = item.status === "failed";
  if (action === "connected_app_search") {
    if (item.name === "tool.started") return `${provider} search`;
    return failed ? `${provider} search failed` : `${provider} search`;
  }
  if (action === "connected_app_read") {
    if (item.name === "tool.started") return `${provider} lookup`;
    return failed ? `${provider} lookup failed` : `${provider} lookup`;
  }
  if (item.name === "tool.started") return `${provider} update`;
  return failed ? `${provider} update failed` : `${provider} update`;
}

export function connectedAppToolActivityContent(item: RuntimeEvent): string | null {
  if (
    item.action !== "connected_app_search" &&
    item.action !== "connected_app_read" &&
    item.action !== "connected_app_write"
  ) {
    return null;
  }
  const metadata = connectedAppEventMetadata(item);
  const parts = [
    metadata.providerOperation,
    metadata.operation && metadata.operation !== metadata.providerOperation ? metadata.operation : null,
    metadata.capabilityCount > 0
      ? `${metadata.capabilityCount} ${metadata.capabilityCount === 1 ? "capability" : "capabilities"}`
      : null,
  ].filter((value): value is string => Boolean(value));
  return parts.join(" / ") || metadata.providerLabel;
}

function connectedAppActivityState(item: RuntimeEvent): ConnectedAppProviderActivityRow["state"] {
  if (item.status === "started") return "running";
  if (item.status === "completed") return "completed";
  if (item.status === "failed") return "failed";
  if (item.status === "pending") return "pending";
  return "unknown";
}

function connectedAppProviderLabel(item: RuntimeEvent): string {
  return connectedAppEventMetadata(item).providerLabel;
}

function connectedAppEventMetadata(item: RuntimeEvent): {
  providerLabel: string;
  providerOperation: string | null;
  operation: string | null;
  capabilityCount: number;
} {
  const args = asRecord(item.args);
  const data = asRecord(item.data);
  const result = asRecord(data?.result);
  const providerId = normalizeConnectedAppProviderFamilyId(
    stringValue(args, ["provider"]) ??
      stringValue(result, ["provider"]) ??
      stringValue(data, ["provider"]) ??
      undefined,
  );
  const providerLabel =
    stringValue(result, ["providerLabel"]) ??
    stringValue(data, ["providerLabel"]) ??
    (providerId ? connectedAppBundleByProvider(providerId)?.label : null) ??
    "connected app";
  const providerOperation = stringValue(args, ["operation"]);
  const operation = stringValue(result, ["operation"]) ?? stringValue(data, ["operation"]);
  const capabilityCount =
    arrayLength(args?.capabilityIds) ||
    arrayLength(result?.capabilityIds) ||
    arrayLength(data?.capabilityIds);
  return {
    providerLabel,
    providerOperation,
    operation,
    capabilityCount,
  };
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}
