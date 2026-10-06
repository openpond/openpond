import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { ModelBindingSchema, type ModelProject } from "@openpond/contracts";
import { connectionQueryScope } from "../../../lib/query-scope";
import { api, type ClientConnection } from "../../../api";
const StateSchema = z.object({
  grants: z.array(z.object({ id: z.string(), role: z.string(), roleTargetId: z.string(), enabled: z.boolean(), authorizedConfigurationHash: z.string().nullable() })),
  bindings: z.array(ModelBindingSchema),
  policies: z.array(z.object({ id: z.string(), revision: z.number(), status: z.string(), servingAuthorized: z.boolean(), configuration: z.object({ name: z.string(), projectId: z.string(), mode: z.string(), serving: z.object({ targetId: z.string() }).optional(), limits: z.object({ perCycleUsd: z.number(), maxGpuSeconds: z.number() }) }) })),
  executions: z.array(z.object({ id: z.string(), status: z.string(), failure: z.string().nullable() })),
});
type State = z.infer<typeof StateSchema>;
export function ConversationServingOwner(props: { connection: ClientConnection; model: ModelProject; readOnly: boolean }) {
  return <ServingOwnerQuery key={`${connectionQueryScope(props.connection)}:${props.model.profileId}:${props.model.id}`} {...props} />;
}
function ServingOwnerQuery({ connection, model, readOnly }: Parameters<typeof ConversationServingOwner>[0]) {
  const [state, setState] = useState<State | null>(null), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const [bindingId, setBindingId] = useState(""), [policyId, setPolicyId] = useState("");
  const generation = useRef(0), pending = useRef(false);
  const path = `/models/${encodeURIComponent(model.id)}/conversation-serving`;
  const scope = new URLSearchParams({ profileId: model.profileId });
  useEffect(() => {
    const token = ++generation.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      if (pending.current) { timer = setTimeout(() => { void load(); }, 10000); return; }
      try {
        const value = StateSchema.parse(await api.trainingRequest<unknown>(connection, `${path}?${scope}`, undefined, "GET"));
        if (generation.current === token && !pending.current) { setState(value); setError(null); }
      } catch (failure) { if (generation.current === token) setError(failure instanceof Error ? failure.message : "The serving owner is unavailable."); }
      if (generation.current === token) timer = setTimeout(() => { void load(); }, 10000);
    };
    void load();
    return () => { generation.current++; clearTimeout(timer); };
  }, [connection, path, model.profileId]);
  async function command(action: "register" | "authorize" | "revoke", body: object) {
    if (pending.current || readOnly) return;
    pending.current = true; setBusy(true); setError(null);
    const token = generation.current;
    try {
      await api.trainingRequest(connection, `${path}/${action}?${scope}`, body);
      const value = StateSchema.parse(await api.trainingRequest<unknown>(connection, `${path}?${scope}`, undefined, "GET"));
      if (token === generation.current) setState(value);
    } catch (failure) { if (token === generation.current) setError(failure instanceof Error ? failure.message : "Serving authorization failed."); }
    finally { pending.current = false; if (token === generation.current) setBusy(false); }
  }
  const selected = state?.policies.find(policy => policy.id === policyId);
  return <section className="training-detail-section" aria-label="Automatic serving authorization">
    <h3>Automatic serving</h3>
    <p>Register an existing OpenPond target, select it on the Project’s conversation policy and save that policy paused. Authorize its exact configuration here, then enable it on the Project. This serving owner must stay connected to apply qualified candidates.</p>
    {error ? <p role="alert">{error}</p> : null}
    {!state && !error ? <p>Loading serving authorization…</p> : null}
    {state ? <>
      <label>Conversation policy<select disabled={busy || readOnly} value={policyId} onChange={event => setPolicyId(event.target.value)}><option value="">Select policy</option>{state.policies.map(policy => <option key={policy.id} value={policy.id}>{policy.configuration.name} / {policy.status}</option>)}</select></label>
      <label>Current OpenPond target<select disabled={busy || readOnly} value={bindingId} onChange={event => setBindingId(event.target.value)}><option value="">Select active binding</option>{state.bindings.map(binding => <option key={binding.id} value={binding.id}>{binding.role} / {binding.roleTargetId}</option>)}</select></label>
      <button type="button" className="training-button secondary" disabled={busy || readOnly || !selected || !bindingId} onClick={() => { if (selected) void command("register", { projectId: selected.configuration.projectId, bindingId }); }}>Register serving target</button>
      {state.grants.map(grant => {
        const policy = state.policies.find(value => value.configuration.mode === "activate" && value.configuration.serving?.targetId === grant.id);
        return <div key={grant.id} className="evaluation-workspace-card"><h4>{grant.role} / {grant.roleTargetId}</h4><p>{grant.enabled ? policy?.servingAuthorized ? "Exact policy authorized" : "Awaiting policy authorization" : "Revoked"}</p>
          {policy ? <><p>{policy.configuration.name}: up to ${policy.configuration.limits.perCycleUsd} per cycle, {policy.configuration.limits.maxGpuSeconds / 3600} GPU hours per session. Independent acceptance and automatic rollback are required.</p><button type="button" className="training-button" disabled={busy || readOnly || !grant.enabled} onClick={() => void command("authorize", { grantId: grant.id, policyId: policy.id, expectedRevision: policy.revision })}>Authorize this exact policy</button></> : <p>Select this target in the Project policy and save it paused.</p>}
          <button type="button" className="training-button secondary" disabled={busy || readOnly || !grant.enabled} onClick={() => void command("revoke", { grantId: grant.id })}>Revoke serving authorization</button>
        </div>;
      })}
      {state.executions.map(execution => <p key={execution.id}>Serving rollout: {execution.status.replaceAll("_", " ")}{execution.failure ? ` / ${execution.failure}` : ""}</p>)}
    </> : null}
  </section>;
}
