import { useCallback, useEffect, useMemo, useState } from "react";
import {
  connectedAppBundleByProvider,
  normalizeConnectedAppProviderFamilyId,
} from "@openpond/contracts";
import { api, type ClientConnection } from "../../api";
import type {
  SandboxIntegrationConnection,
  SandboxIntegrationLeaseRef,
  SandboxRecord,
} from "../../lib/sandbox-types";
import { LoaderCircle, Plug, RefreshCw, Trash2 } from "../icons";
import { useErrorToast } from "../../app/AppToastContext";

type IntegrationBusyState = "load" | `attach:${string}` | `remove:${string}` | null;

export function SandboxWorkspaceSummary({
  sandboxId,
  connection,
}: {
  sandboxId: string | null;
  connection: ClientConnection | null;
}) {
  const [sandbox, setSandbox] = useState<SandboxRecord | null>(null);
  const [integrationConnections, setIntegrationConnections] = useState<SandboxIntegrationConnection[]>([]);
  const [busy, setBusy] = useState<"summary" | null>(null);
  const [integrationBusy, setIntegrationBusy] = useState<IntegrationBusyState>(null);
  const [error, setError] = useState<string | null>(null);
  const [integrationError, setIntegrationError] = useState<string | null>(null);
  useErrorToast(error, { prefix: "Sandbox" });
  useErrorToast(integrationError, { prefix: "Sandbox integrations" });

  const integrationLeases = sandbox?.integrationLeases ?? [];
  const availableIntegrationConnections = useMemo(
    () => integrationConnections.filter((item) => item.status === "active"),
    [integrationConnections],
  );
  const latestReceipt = useMemo(() => latestSandboxReceipt(sandbox), [sandbox]);

  const refreshSummary = useCallback(async () => {
    if (!connection) {
      setError("OpenPond App server is not connected.");
      return;
    }
    if (!sandboxId) {
      setSandbox(null);
      setIntegrationConnections([]);
      setError(null);
      return;
    }
    setBusy("summary");
    setError(null);
    try {
      const sandboxResult = await api.sandbox(connection, sandboxId);
      const connectionsResult = await api.integrationConnections(
        connection,
        sandboxAvailableIntegrationConnectionListInput(sandboxResult.sandbox),
      );
      setSandbox(sandboxResult.sandbox);
      setIntegrationConnections(connectionsResult.connections);
      setIntegrationError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setBusy(null);
    }
  }, [connection, sandboxId]);

  const refreshIntegrations = useCallback(async () => {
    if (!connection || !sandbox) return;
    setIntegrationBusy("load");
    setIntegrationError(null);
    try {
      const [connectionsResult, leasesResult] = await Promise.all([
        api.integrationConnections(connection, sandboxAvailableIntegrationConnectionListInput(sandbox)),
        api.sandboxIntegrationLeases(connection, sandbox.id),
      ]);
      setIntegrationConnections(connectionsResult.connections);
      setSandbox(leasesResult.sandbox);
    } catch (loadError) {
      setIntegrationError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setIntegrationBusy(null);
    }
  }, [connection, sandbox]);

  const attachIntegrationConnection = useCallback(
    async (integrationConnection: SandboxIntegrationConnection) => {
      if (!connection || !sandbox) return;
      const provider = normalizeConnectedAppProviderFamilyId(integrationConnection.provider);
      const bundle = provider ? connectedAppBundleByProvider(provider) : null;
      const capabilities = bundle?.leasePolicy.allowedCapabilityIds ?? [];
      if (!provider || !bundle?.leasePolicy.leaseable || capabilities.length === 0) {
        setIntegrationError(`${providerLabel(integrationConnection.provider)} cannot be attached to this sandbox.`);
        return;
      }
      setIntegrationBusy(`attach:${integrationConnection.id}`);
      setIntegrationError(null);
      try {
        const result = await api.attachSandboxIntegrationConnection(connection, sandbox.id, {
          connectionId: integrationConnection.id,
          provider: integrationConnection.provider,
          capabilities,
          ...(integrationConnection.scopes.length > 0 ? { scopes: integrationConnection.scopes } : {}),
          ...(bundle.leasePolicy.defaultTtlSeconds
            ? { ttlSeconds: bundle.leasePolicy.defaultTtlSeconds }
            : {}),
          required: false,
        });
        setSandbox(result.sandbox);
      } catch (attachError) {
        setIntegrationError(attachError instanceof Error ? attachError.message : String(attachError));
      } finally {
        setIntegrationBusy(null);
      }
    },
    [connection, sandbox],
  );

  const removeIntegrationLease = useCallback(
    async (leaseId: string) => {
      if (!connection || !sandbox) return;
      setIntegrationBusy(`remove:${leaseId}`);
      setIntegrationError(null);
      try {
        const result = await api.removeSandboxIntegrationLease(connection, sandbox.id, leaseId);
        setSandbox(result.sandbox);
      } catch (removeError) {
        setIntegrationError(removeError instanceof Error ? removeError.message : String(removeError));
      } finally {
        setIntegrationBusy(null);
      }
    },
    [connection, sandbox],
  );

  useEffect(() => {
    void refreshSummary();
  }, [refreshSummary]);

  if (!sandboxId) {
    return (
      <div className="sandbox-summary-tab">
        <p className="sandbox-workspace-empty">No sandbox is attached yet.</p>
      </div>
    );
  }

  return (
    <div className="sandbox-summary-tab">
      <section className="sandbox-workspace-section">
        <div className="sandbox-workspace-heading">
          <h3>Sandbox</h3>
          <div className="sandbox-workspace-heading-actions">
            {sandbox ? <span>{sandbox.state}</span> : null}
            <button
              type="button"
              className="diff-icon-button"
              title="Refresh summary"
              aria-label="Refresh summary"
              disabled={busy !== null}
              onClick={() => void refreshSummary()}
            >
              {busy === "summary" ? <LoaderCircle className="spinning" size={14} /> : <RefreshCw size={14} />}
            </button>
          </div>
        </div>
        {sandbox ? (
          <dl className="sandbox-workspace-kv">
            <div>
              <dt>Sandbox</dt>
              <dd>{shortId(sandbox.id)}</dd>
            </div>
            <div>
              <dt>Runtime</dt>
              <dd>{sandbox.runtimeDriver}</dd>
            </div>
            <div>
              <dt>Spend</dt>
              <dd>
                {formatUsd(sandbox.reservation.capturedUsd)} / {formatUsd(sandbox.budget.maxUsd)}
              </dd>
            </div>
            <div>
              <dt>Reservation</dt>
              <dd>{sandbox.reservation.status}</dd>
            </div>
            <div>
              <dt>Idle cleanup</dt>
              <dd>{sandbox.quotas?.idleTimeoutSeconds ? `${Math.round(sandbox.quotas.idleTimeoutSeconds / 60)} min` : "-"}</dd>
            </div>
            <div>
              <dt>Updated</dt>
              <dd>{formatDate(sandbox.updatedAt)}</dd>
            </div>
            {latestReceipt ? (
              <div>
                <dt>Receipt</dt>
                <dd>
                  {shortId(latestReceipt.id)} / {formatUsd(latestReceipt.totalUsd)}
                </dd>
              </div>
            ) : null}
          </dl>
        ) : (
          <div className="sandbox-workspace-loading">
            {busy === "summary" ? <LoaderCircle className="spinning" size={16} /> : null}
            <span>{busy === "summary" ? "Loading sandbox" : "Sandbox unavailable"}</span>
          </div>
        )}
      </section>

      <section className="sandbox-workspace-section">
        <div className="sandbox-workspace-heading">
          <h3>Integrations</h3>
          <div className="sandbox-workspace-heading-actions">
            <span>{integrationLeases.length}</span>
            <button
              type="button"
              className="diff-icon-button"
              title="Refresh integrations"
              aria-label="Refresh integrations"
              disabled={integrationBusy !== null || !sandbox}
              onClick={() => void refreshIntegrations()}
            >
              {integrationBusy === "load" ? <LoaderCircle className="spinning" size={14} /> : <RefreshCw size={14} />}
            </button>
          </div>
        </div>
        {integrationLeases.length > 0 ? (
          <div className="sandbox-workspace-integration-list">
            {integrationLeases.map((lease) => (
              <div className="sandbox-workspace-integration-row" key={lease.leaseId}>
                <div className="sandbox-workspace-integration-main">
                  <span>{providerLabel(lease.provider)}</span>
                  <small>
                    {lease.required ? "required" : "optional"} / {leaseExpiryLabel(lease)}
                    {" / "}
                    {integrationLeaseRuntimeAccessLabel(lease)}
                  </small>
                </div>
                <button
                  type="button"
                  className="diff-icon-button"
                  title={`Revoke ${providerLabel(lease.provider)} lease`}
                  aria-label={`Revoke ${providerLabel(lease.provider)} lease`}
                  disabled={integrationBusy !== null}
                  onClick={() => void removeIntegrationLease(lease.leaseId)}
                >
                  {integrationBusy === `remove:${lease.leaseId}` ? (
                    <LoaderCircle className="spinning" size={14} />
                  ) : (
                    <Trash2 size={14} />
                  )}
                </button>
                <div className="sandbox-workspace-chip-row">
                  {lease.capabilities.slice(0, 5).map((capabilityId) => (
                    <span key={capabilityId}>{capabilityLabel(lease.provider, capabilityId)}</span>
                  ))}
                  {lease.capabilities.length > 5 ? <span>+{lease.capabilities.length - 5}</span> : null}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="sandbox-workspace-empty">No active integration leases.</p>
        )}
        {availableIntegrationConnections.length > 0 ? (
          <div className="sandbox-workspace-integration-list">
            {availableIntegrationConnections.map((integrationConnection) => {
              const attached = integrationLeases.some((lease) => lease.provider === integrationConnection.provider);
              const bundle = connectedAppBundleForConnection(integrationConnection);
              const capabilityCount = bundle?.leasePolicy.allowedCapabilityIds.length ?? 0;
              return (
                <div className="sandbox-workspace-integration-row compact" key={integrationConnection.id}>
                  <div className="sandbox-workspace-integration-main">
                    <span>{connectionAccountLabel(integrationConnection)}</span>
                    <small>{connectionDetail(integrationConnection, capabilityCount)}</small>
                  </div>
                  <button
                    type="button"
                    className="diff-icon-button"
                    title={attached ? `${providerLabel(integrationConnection.provider)} already attached` : `Attach ${providerLabel(integrationConnection.provider)}`}
                    aria-label={attached ? `${providerLabel(integrationConnection.provider)} already attached` : `Attach ${providerLabel(integrationConnection.provider)}`}
                    disabled={attached || integrationBusy !== null || capabilityCount === 0}
                    onClick={() => void attachIntegrationConnection(integrationConnection)}
                  >
                    {integrationBusy === `attach:${integrationConnection.id}` ? (
                      <LoaderCircle className="spinning" size={14} />
                    ) : (
                      <Plug size={14} />
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="sandbox-workspace-empty">No connected accounts available.</p>
        )}
      </section>
    </div>
  );
}

export function sandboxAvailableIntegrationConnectionListInput(
  sandbox: Pick<SandboxRecord, "teamId" | "projectId"> | null,
): { status: "active" } {
  void sandbox;
  return { status: "active" };
}

export function integrationLeaseRuntimeAccessLabel(
  lease: Pick<SandboxIntegrationLeaseRef, "proxyUrl">,
): string {
  return lease.proxyUrl ? "runtime proxy available" : "metadata only, no runtime proxy";
}

function latestSandboxReceipt(sandbox: SandboxRecord | null) {
  return sandbox?.receipts?.at(-1) ?? null;
}

function connectedAppBundleForConnection(connection: SandboxIntegrationConnection) {
  const provider = normalizeConnectedAppProviderFamilyId(connection.provider);
  return provider ? connectedAppBundleByProvider(provider) : null;
}

function providerLabel(provider: string): string {
  const normalized = normalizeConnectedAppProviderFamilyId(provider);
  const bundle = normalized ? connectedAppBundleByProvider(normalized) : null;
  if (bundle) return bundle.label;
  if (provider === "microsoft_teams") return "Microsoft Teams";
  return provider ? provider.replace(/_/g, " ") : "Integration";
}

function capabilityLabel(provider: string, capabilityId: string): string {
  const normalized = normalizeConnectedAppProviderFamilyId(provider);
  const bundle = normalized ? connectedAppBundleByProvider(normalized) : null;
  return bundle?.capabilities.find((capability) => capability.id === capabilityId)?.label ?? capabilityId;
}

function leaseExpiryLabel(lease: SandboxIntegrationLeaseRef): string {
  return lease.expiresAt ? `expires ${formatDate(lease.expiresAt)}` : "active";
}

function connectionAccountLabel(connection: SandboxIntegrationConnection): string {
  const account = connection.providerAccountName?.trim();
  return account ? `${providerLabel(connection.provider)} / ${account}` : providerLabel(connection.provider);
}

function connectionDetail(connection: SandboxIntegrationConnection, capabilityCount: number): string {
  const parts: string[] = [];
  if (connection.providerWorkspaceName) parts.push(connection.providerWorkspaceName);
  parts.push(`${capabilityCount} lease ${capabilityCount === 1 ? "capability" : "capabilities"}`);
  if (connection.scopes.length > 0) parts.push(`${connection.scopes.length} ${connection.scopes.length === 1 ? "scope" : "scopes"}`);
  return parts.join(" / ");
}

function shortId(value: string): string {
  return value.length > 10 ? `${value.slice(0, 8)}...` : value;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "-";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatUsd(value: string | number | null | undefined): string {
  const amount = Number(value ?? 0);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: amount >= 10 ? 2 : 4,
  }).format(Number.isFinite(amount) ? amount : 0);
}
