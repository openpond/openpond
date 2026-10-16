import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { PonderHostedAssignmentDetail } from "@openpond/contracts";
import { apiFetch, type ClientConnection } from "../../api/api-client";
import { connectionQueryScope } from "../../lib/query-scope";
import { normalizeBrowserUrl } from "../../lib/browser-url";
import { useErrorToast } from "../../app/AppToastContext";

type HostedOutput = PonderHostedAssignmentDetail["outputs"][number];

/** Resolve fresh signed links only after a click, through the assignment's pinned owner. */
export function HostedAgentOutput({connection, accountScopeKey, assignmentId, output}: {
  connection: ClientConnection; accountScopeKey: string; assignmentId: string; output: HostedOutput;
}) {
  const queries = useQueryClient();
  const scope = JSON.stringify([connectionQueryScope(connection), accountScopeKey, assignmentId]);
  const currentScope = useRef<string | null>(scope); currentScope.current = scope;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { currentScope.current = scope; setBusy(false); setError(null); return () => { currentScope.current = null; }; }, [scope]);
  useErrorToast(error);
  async function open(kind: "preview" | "download") {
    if (busy) return;
    const origin = scope;
    const tab = window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    setBusy(true); setError(null);
    try {
      const value = await queries.fetchQuery({
        queryKey: ["ponder-hosted-output", connectionQueryScope(connection), accountScopeKey, assignmentId, output.id],
        staleTime: 0, gcTime: 60000,
        queryFn: ({signal}) => apiFetch<HostedOutput>(connection,
          `/v1/ponder/local/hosted-agents/${encodeURIComponent(assignmentId)}/outputs/${encodeURIComponent(output.id)}`, { signal }),
      });
      if (currentScope.current !== origin) { tab?.close(); return; }
      const raw = kind === "preview" ? value.previewURL : value.downloadURL;
      const url = raw ? normalizeBrowserUrl(raw) : null;
      if (!url) throw new Error(kind === "preview" ? "This output is not available for preview." : "This output is not available for download.");
      if (tab) tab.location.replace(url);
      else window.location.assign(url);
    } catch (cause) {
      tab?.close();
      if (currentScope.current === origin) setError(cause instanceof Error ? cause.message : String(cause));
    } finally { if (currentScope.current === origin) setBusy(false); }
  }
  return <div><strong>{output.name}</strong>
    {output.previewURL ? <button type="button" disabled={busy} onClick={() => void open("preview")}>Preview</button> : null}
    <button type="button" disabled={busy} aria-label={`Download ${output.name}`} onClick={() => void open("download")}>{busy ? "Preparing…" : "Download"}</button>
  </div>;
}
