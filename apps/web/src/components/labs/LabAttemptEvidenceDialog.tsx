import { useEffect, useState } from "react";

import { AppDialog } from "../dialogs/AppDialog";
import { X } from "../icons";

export type AttemptEvidencePayload = {
  runId: string;
  attemptId: string;
  kind: "transcript" | "trace";
  artifactPath: string;
  jsonPointer: string;
  contentHash: string | null;
  value: unknown;
};

export function LabAttemptEvidenceDialog({
  attemptId,
  kind,
  onClose,
  onLoad,
  runId,
}: {
  attemptId: string;
  kind: "transcript" | "trace";
  onClose: () => void;
  onLoad: (input: { runId: string; attemptId: string; kind: "transcript" | "trace" }) => Promise<AttemptEvidencePayload | null>;
  runId: string;
}) {
  const [payload, setPayload] = useState<AttemptEvidencePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    void onLoad({ runId, attemptId, kind }).then((next) => {
      if (disposed) return;
      if (next) setPayload(next);
      else setError(`The ${kind} evidence could not be loaded.`);
    }).catch((caught) => {
      if (!disposed) setError(caught instanceof Error ? caught.message : String(caught));
    });
    return () => { disposed = true; };
  }, [attemptId, kind, onLoad, runId]);

  return <AppDialog ariaLabel={`${kind} evidence`} backdropClassName="labs-rename-backdrop" className="labs-rename-dialog labs-attempt-evidence-dialog" onClose={onClose}>
    <header><div><h2>{kind === "transcript" ? "Attempt transcript" : "Attempt trace"}</h2><p>{attemptId}</p></div><button aria-label="Close evidence" type="button" onClick={onClose}><X size={16} /></button></header>
    {payload ? <>
      <dl className="labs-inline-facts">
        <div><dt>Receipt hash</dt><dd className="labs-mono-value">{payload.contentHash ?? "Unavailable"}</dd></div>
        <div><dt>JSON pointer</dt><dd className="labs-mono-value">{payload.jsonPointer}</dd></div>
        <div><dt>Artifact</dt><dd className="labs-mono-value">{payload.artifactPath}</dd></div>
      </dl>
      <pre className="labs-attempt-evidence-json">{JSON.stringify(payload.value, null, 2)}</pre>
    </> : error ? <div className="labs-rename-error" role="alert">{error}</div> : <div className="training-run-placeholder">Loading authorized receipt evidence…</div>}
    <footer><button type="button" onClick={onClose}>Close</button></footer>
  </AppDialog>;
}
