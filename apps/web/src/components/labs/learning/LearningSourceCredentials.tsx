import { useEffect, useRef, useState } from "react";
import { createSourceCredentialRequest, type OpenPondLearningClient } from "openpond-sdk/learning";
import { useDraftNavigation } from "../useDraftNavigation";
import { LearningActions, LearningError, LearningPager } from "./LearningFields";
import { useLearningMutation } from "./useLearningResources";

type CredentialPage = Awaited<ReturnType<OpenPondLearningClient["listSourceCredentials"]>>;
type IssuedCredential = Awaited<ReturnType<OpenPondLearningClient["createSourceCredential"]>>;

export function LearningSourceCredentials({ client, sourceId }: { client: OpenPondLearningClient | null; sourceId: string }) {
  const [after, setAfter] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const [page, setPage] = useState<{ client: OpenPondLearningClient | null; key: string; data: CredentialPage | null; error: string | null } | null>(null);
  const key = `${sourceId}:${after ?? ""}`;
  useEffect(() => {
    const abort = new AbortController();
    async function read() {
      try {
        if (!client) throw new Error("Connect to OpenPond to manage source access.");
        const data = await client.listSourceCredentials(sourceId, { limit: 30, ...(after ? { afterId: after } : {}) }, { signal: abort.signal });
        if (!abort.signal.aborted) setPage({ client, key, data, error: null });
      } catch (error) { if (!abort.signal.aborted) setPage({ client, key, data: null, error: error instanceof Error ? error.message : String(error) }); }
    }
    void read();
    return () => abort.abort();
  }, [client, sourceId, after, key, generation]);
  const currentPage = page?.client === client && page.key === key ? page : null;
  const [name, setName] = useState("Application intake");
  const [days, setDays] = useState(30);
  const [issued, setIssued] = useState<{ client: OpenPondLearningClient; sourceId: string; value: IssuedCredential } | null>(null);
  const [showSecret, setShowSecret] = useState(false);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const pending = useRef<{ client: OpenPondLearningClient; key: string; request: ReturnType<typeof createSourceCredentialRequest> } | null>(null);
  const mutation = useLearningMutation(client);
  const guard = useDraftNavigation({ name: "source credential", dirty: false, busy: mutation.busy });
  const currentIssued = issued?.client === client && issued.sourceId === sourceId ? issued.value : null;
  async function create() {
    const result = await mutation.run(async (api) => {
      const requestKey = JSON.stringify({ sourceId, name: name.trim(), days });
      if (pending.current?.client !== api || pending.current.key !== requestKey) pending.current = { client: api, key: requestKey, request: createSourceCredentialRequest({ sourceId, name: name.trim(), expiresAt: new Date(Date.now() + days * 86_400_000).toISOString() }) };
      const value = await api.createSourceCredential(pending.current.request);
      setIssued({ client: api, sourceId, value });
      pending.current = null;
      setCopyStatus(null);
      setShowSecret(false);
      return value;
    });
    if (result) setGeneration((value) => value + 1);
  }
  async function revoke(id: string) {
    if (await mutation.run((api) => api.revokeSourceCredential(sourceId, id))) {
      if (currentIssued?.credential.id === id) setIssued(null);
      setGeneration((value) => value + 1);
    }
  }
  return <section>
    <h3>Application access</h3>
    <p>Create a credential for this source. It can submit examples and feedback, but cannot read private evidence, grade, approve, train or manage models.</p>
    <p>Source: <code>{sourceId}</code></p>
    <LearningError error={mutation.error ?? currentPage?.error ?? null} />
    <label>Credential name<input value={name} maxLength={100} disabled={mutation.busy} onChange={(event) => setName(event.target.value)} /></label>
    <label>Expires after<select value={days} disabled={mutation.busy} onChange={(event) => setDays(Number(event.target.value))}><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option></select></label>
    <LearningActions><button type="button" className="training-button" disabled={!client || !name.trim() || mutation.busy} onClick={() => { void create(); }}>Create source credential</button></LearningActions>
    {currentIssued ? <div role="status"><p>Copy this credential now. Its secret will not be shown again after closing.</p><label>Source credential<input type={showSecret ? "text" : "password"} readOnly value={currentIssued.apiKey} autoComplete="off" /></label><LearningActions><button type="button" className="training-button secondary" onClick={async () => { try { await navigator.clipboard.writeText(currentIssued.apiKey); setCopyStatus("Credential copied."); } catch { setCopyStatus("Clipboard access failed. Show the credential, then select and copy it."); } }}>Copy credential</button><button type="button" className="training-button secondary" onClick={() => setShowSecret((value) => !value)}>{showSecret ? "Hide credential" : "Show credential"}</button><button type="button" className="training-button secondary" onClick={() => { setIssued(null); setShowSecret(false); }}>Dismiss credential</button></LearningActions>{copyStatus ? <p>{copyStatus}</p> : null}</div> : null}
    {!currentPage ? <p role="status">Loading source credentials…</p> : <div className="training-table-wrap"><table className="training-data-table"><thead><tr><th>Name</th><th>Key prefix</th><th>Expires</th><th>Status</th><th>Action</th></tr></thead><tbody>{currentPage.data?.items.map((credential) => <tr key={credential.id}><td>{credential.name}</td><td><code>{credential.keyPrefix}</code></td><td>{new Date(credential.expiresAt).toLocaleString()}</td><td>{credential.revokedAt ? "Revoked" : Date.parse(credential.expiresAt) <= Date.now() ? "Expired" : "Active"}</td><td><button type="button" className="training-button secondary" disabled={mutation.busy || credential.revokedAt !== null} onClick={() => { void revoke(credential.id); }}>Revoke</button></td></tr>)}</tbody></table>{currentPage.data && !currentPage.data.items.length ? <p>No source credentials on this page.</p> : null}</div>}
    <LearningPager after={after} next={currentPage?.data?.nextCursor} onPage={setAfter} />
    {guard.dialog}
  </section>;
}
