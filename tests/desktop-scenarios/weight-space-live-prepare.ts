import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { desktopScenario } from "../../scripts/desktop-harness/scenario";
import { reloadRenderer, waitForRendererCondition, waitForSidebarSessionRow } from "./helpers";

// Manual connected acceptance: a real subscribed Codex agent must discover the
// current WSP capability and preserve its admission boundary across UI reload.
// This scenario never registers a scripted provider or creates synthetic runs.
export default desktopScenario({
  name: "weight-space-live-prepare",
  mode: "attach",
  timeoutMs: 600_000,
  async run(harness) {
    if (harness.launchMode !== "attach") throw new Error("Use the authenticated development Desktop with --attach.");
    const bootstrap = await harness.api.bootstrap<any>();
    const codex = bootstrap.providers?.statuses?.codex;
    if (!codex?.available || !codex.modelIds.includes("gpt-6.1-sol")) throw new Error("The configured Codex subscription must offer gpt-6.1-sol.");
    const modelRef = { providerId: "codex", modelId: "gpt-6.1-sol" };
    const resumeId = process.env.OPENPOND_WSP_ACCEPTANCE_SESSION_ID;
    const workingDirectory = resumeId ? null : await mkdtemp(path.join(os.tmpdir(), "openpond-wsp-acceptance-"));
    const session = resumeId ? { id: resumeId, title: "WSP preparation acceptance" } : await harness.api.createSession<{ id: string; title: string }>({
      experience: "chat", provider: "codex", modelRef,
      title: harness.uniqueTitle("WSP prepare-only acceptance"),
      cwd: workingDirectory,
    });
    harness.recordMetadata({ sessionId: session.id, modelRef, workingDirectory, liveAgent: true, mockedProvider: false });
    await reloadRenderer(harness);
    await waitForSidebarSessionRow(harness, session.id);
    await harness.renderer.selectSession(session.id);
    const prompt = "Prepare a weight-space programming experiment using the exact supported dense BF16 Qwen3-8B checkpoint in the current selected OpenPond workspace. Use this local agent as teacher. The objective is to answer simple arithmetic concisely. I explicitly review this development panel: user prompt 'What is 2 + 2? Reply with only the number.' and this preservation panel: user prompt 'What is the capital of France? Reply with only the city.' Fixed greedy generation, seed 0, maximum 16 output tokens per prompt. Proposed remote compute ceiling $1 total, duration 120 seconds and idle timeout 60 seconds. This is PREPARATION ONLY: do not start compute, allocate or resume a worker, execute tensor edits or evaluation, score outputs, activate serving or create any schedule. Resolve the exact base/tokenizer and runtime through the official bundled CLI. If the exact runtime is unavailable, retain its exact reason and stop; do not change the model or claim successful preparation. Attach any genuinely accepted preparation to this chat and report its stable identity; if preparation cannot be accepted, clearly say there is no accepted session. Use the installed OpenPond CLI skill/reference and command help; this empty working directory has no development checkout, so do not inspect application repository source files to discover request fields. Do not implement code or modify repository files.";
    if (!resumeId) await harness.renderer.submitComposer(prompt);
    const completed = await harness.events.waitFor(event => event.sessionId === session.id && event.name === "turn.completed", "live WSP preparation turn", { sessionId: session.id, timeoutMs: 570_000 });
    if (completed.status !== "completed") throw new Error(`The live WSP turn ended as ${completed.status}.`);
    const page = await harness.api.eventPage<{ events?: Record<string, any>[]; items?: Record<string, any>[] }>({ sessionId: session.id, limit: 500 });
    const events = (page.events ?? page.items ?? []).map(entry => entry.event ?? entry);
    const tools = events.filter(event => event.name.startsWith("tool.")).map(event => ({ name: event.name, action: event.action, status: event.status, data: event.data, output: event.output }));
    const commandEvidence = tools.filter(event => event.name === "tool.started" || event.name === "tool.requested").map(event => JSON.stringify(event.data)).join("\n");
    if (/\/(?:packages\/[^/]+\/src|apps\/[^/]+\/src|lib\/sandbox)\//.test(commandEvidence)) throw new Error("The installed agent depended on developer source paths.");
    const cliReceipts = tools.flatMap(event => {
      if (event.name !== "tool.completed" || event.data?.tool !== "openpond_exec_command") return [];
      const envelope = event.data?.result?.content?.find((item: any) => item.type === "text");
      if (!envelope) return [];
      const commandResult = JSON.parse(envelope.text);
      if (commandResult?.data?.exitCode !== 0) return [];
      try { return [JSON.parse(commandResult.data.stdout)]; }
      catch { return []; }
    });
    const capability = cliReceipts.filter(value => value.schemaVersion === "openpond.weightSpaceCapability.v1").at(-1);
    if (capability?.schemaVersion !== "openpond.weightSpaceCapability.v1") throw new Error("The actual agent did not obtain a WSP capability receipt through the official CLI.");
    if (/hosted-(?:start-weight-space|control-weight-space-serving|worker-resume|base-serving-prepare)\b/.test(commandEvidence)) throw new Error("The agent attempted compute despite preparation-only scope.");
    const preparation = cliReceipts.find(value => value.schemaVersion === "openpond.weightSpaceExecutionReceipt.v1");
    if (capability.execution.state === "ready" && !preparation) throw new Error("The runtime was ready but the actual agent did not obtain an accepted preparation.");
    if (preparation && preparation.execution.phase !== "prepared") throw new Error("Preparation advanced beyond the prepared state.");
    const transcript = events.filter(event => ["assistant.delta", "assistant.message", "turn.completed"].includes(event.name)).map(event => ({ name: event.name, status: event.status, output: event.output }));
    await mkdir(harness.artifactsDir, { recursive: true });
    await writeFile(path.join(harness.artifactsDir, "live-agent-evidence.json"), JSON.stringify({ sessionId: session.id, modelRef, completedTurnId: completed.turnId, capability, preparation, tools, transcript }, null, 2));
    await reloadRenderer(harness);
    await waitForSidebarSessionRow(harness, session.id);
    await harness.renderer.selectSession(session.id);
    await waitForRendererCondition(harness, `document.querySelector('.chat-thread[aria-label="Conversation"]')?.textContent?.includes(${JSON.stringify("PREPARATION ONLY")})`, "persisted preparation-only request");
    if (preparation) {
      const current = await harness.api.fetchJson<any>("/v1/local-datasets", { method: "POST", body: { action: "context_selection", payload: { sessionId: session.id } } });
      if (current.selection?.target?.kind !== "weight_space_session" || current.selection.target.id !== preparation.execution.id || current.selection.weightSpace?.phase !== "prepared") throw new Error("Reload did not retain the original accepted editing-session attachment.");
      await harness.renderer.assertText(preparation.execution.name, { label: "accepted WSP preparation in reopened chat" });
      harness.recordAssertion("acceptedSessionAttachmentReopened", true);
    }
    harness.recordAssertion("realAgentCapabilityDiscovery", true);
    harness.recordAssertion("noComputeStartAttempt", true);
    harness.recordAssertion("requestReopenedAfterReload", true);
    harness.recordMetadata({ evidencePath: path.join(harness.artifactsDir, "live-agent-evidence.json"), toolEventCount: tools.length,
      admission: capability.execution, acceptedPreparationProven: Boolean(preparation), acceptedSessionAttachmentProven: Boolean(preparation) });
    await harness.screenshot("weight-space-live-preparation-reopened");
  },
});
