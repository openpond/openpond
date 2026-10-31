import { useState } from "react";
import { DropdownSelect } from "../DropdownSelect";
import { useErrorToast } from "../../app/AppToastContext";
import { useAgentDialogFocus } from "../apps/useAgentDialogFocus";
import { X } from "../icons";
import { captureClientName, type FixItContext } from "./client";

export function FixItSetup({ context, baseUrl, onClose }: { context: FixItContext; baseUrl: string; onClose(): void }) {
  const [client, setClient] = useState("claude_code"), [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useAgentDialogFocus(onClose);
  useErrorToast(error);
  async function copy() {
    try {
      await navigator.clipboard.writeText(`Read ${new URL("/agent-setup.md", baseUrl).href} and connect ${captureClientName(client)} tool capture to my private saved Fix-it dataset. Reuse my existing OpenPond home and account and select workspace ${context.teamId}. Inspect openpond tool-learning --help and the Model commands. Reuse an owner-controlled private capture Model, or create one if needed, without activating training. All my connected agents should contribute to the same Fix-it dataset. I consent to bounded, sanitized tool arguments, error excerpts and follow-up actions from the workspace I select being saved as dataset records until I remove them; raw capture buffers retain their separate bounded retention. Confirm the actual client version and exact permitted tool names, then use tool-learning setup --client ${client} --team-id ${context.teamId} --project-id <private-capture-model> --workspace <chosen-workspace> --environment-file <bounded-context-file> --tools <exact-tool-names> --allow-upload with my existing home/account. Preserve unrelated hooks and permissions. ${client === "codex" ? "Use the installed openpond-fix-it skill and tool-learning run for captured Codex CLI tasks; ordinary Codex desktop chats are outside this connection." : ""} Use doctor to verify observed capture and inspect the uploaded records through the normal dataset commands. Do not import conversation history, start OpenPond inference or training, provision compute, or activate a specialist.`);
      setError(null); setCopied(true);
    } catch { setError("The setup prompt could not be copied. Please retry."); }
  }
  return <div className="git-dialog-backdrop provider-dialog-backdrop" onMouseDown={onClose}>
    <section ref={ref} className="git-dialog provider-details-dialog agent-setup-dialog" role="dialog" aria-modal="true" aria-label="Connect Fix-it" onMouseDown={event => event.stopPropagation()}>
      <button className="git-dialog-close" aria-label="Close" onClick={onClose}><X size={16} /></button>
      <div className="provider-dialog-header"><div><h2>Connect Fix-it</h2><span>Tool capture to your saved dataset</span></div></div>
      <div className="provider-dialog-body">
      <div className="agent-sync-form">
      <label>Coding agent<DropdownSelect label="Fix-it coding agent" value={client} onChange={value => { setClient(value); setCopied(false); }} options={[{ value: "claude_code", label: "Claude Code" }, { value: "opencode", label: "OpenCode" }, { value: "codex", label: "Codex CLI" }, { value: "openpond", label: "OpenPond" }]} /></label></div>
      {client === "codex" ? <p className="provider-dialog-note">Captures tasks launched through the installed Codex CLI skill. Existing desktop chats are outside this connection.</p> : null}
      <div className="settings-button-row"><button className="agent-connect-button" onClick={() => void copy()}>{copied ? "Setup prompt copied" : "Copy capture setup prompt"}</button></div>
      <p className="provider-dialog-note">Paste this into your agent in the workspace you want to connect. Captures stay in your saved dataset until removed. Training stays off.</p></div>
    </section>
  </div>;
}
