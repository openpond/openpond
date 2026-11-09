import { writeFile } from "node:fs/promises";
import path from "node:path";
import { desktopScenario } from "../../scripts/desktop-harness/scenario";
import { reloadRenderer, waitForRendererCondition } from "./helpers";

// Manual real-agent acceptance: exercise the card exactly as a user sees it.
// No fixture, attached file, extra instruction or synthetic provider is injected.
export default desktopScenario({
  name: "model-training-workflow", mode: "attach", timeoutMs: 1_200_000,
  async run(harness) {
    if (harness.launchMode !== "attach") throw new Error("Use the running authenticated Desktop with --attach.");
    const method = process.env.OPENPOND_WORKFLOW_CASE ?? "sft";
    const titles: Record<string, string> = {
      sft: "Train a model with SFT", grpo: "Train a model with RL", decision: "Train a Decision Model",
    };
    if (!titles[method]) throw new Error("Choose sft, grpo or decision; WSP remains unavailable.");
    const providers = await harness.api.fetchJson<any>("/v1/providers");
    if (!providers.statuses.codex?.available || !providers.statuses.codex.modelIds.includes("gpt-6.1-sol")) {
      throw new Error("The installed Codex agent must offer GPT-6.1 Sol.");
    }
    const configuration = await harness.api.fetchJson<any>("/v1/configuration");
    await harness.api.fetchJson("/v1/configuration", { method: "POST", body: {
      action: "client-state", owner: configuration.clientState.owner,
      patch: { chatSelection: { provider: "codex", model: "gpt-6.1-sol" }, chatMode: "chat" },
    } });
    const receipt: Record<string, any> = { method, liveAgent: true, mockedProvider: false, events: [] };
    const evidencePath = path.join(harness.artifactsDir, "workflow-evidence.private.json");
    const save = () => writeFile(evidencePath, JSON.stringify(receipt, null, 2));
    await reloadRenderer(harness);
    await waitForRendererCondition(harness, `!!document.querySelector('button[aria-label="New thread"]')`, "new chat action", { timeoutMs: 20_000 });
    await harness.renderer.evaluate(`document.querySelector('button[aria-label="New thread"]').click()`);
    await waitForRendererCondition(harness, `!!document.querySelector('.model-training-starter')`, "new-chat cards", { timeoutMs: 20_000 });
    const initialText = await harness.renderer.evaluate<string>(`document.querySelector('.composer-inline-input')?.innerText ?? ''`);
    if (initialText.trim()) {
      if (process.env.OPENPOND_CLEAR_TEST_DRAFT !== "1") throw new Error("New chat has an existing draft; preserve it instead of mixing it into card acceptance.");
      await writeFile(path.join(harness.artifactsDir, "previous-draft.private.txt"), initialText);
      await harness.renderer.replaceComposerText!("");
    }
    await harness.renderer.evaluate(`(() => {
      const card = [...document.querySelectorAll('.model-training-starter')].find(button => button.querySelector('.model-training-starter-title')?.textContent === ${JSON.stringify(titles[method])});
      if (!card || card.disabled) throw Error('Supported starter unavailable');
      card.click();
    })()`);
    receipt.prompt = await harness.renderer.evaluate(`document.querySelector('.composer-inline-input')?.innerText`);
    if (!receipt.prompt?.trim()) throw new Error("The card did not populate the composer.");
    receipt.attachedFileCount = await harness.renderer.evaluate(`document.querySelectorAll('form.composer .composer-attachment-card').length`);
    if (receipt.attachedFileCount) throw new Error("Card-only acceptance requires a chat without attached files.");
    await save();
    await harness.renderer.evaluate(`(() => {
      const button = document.querySelector('form.composer button[aria-label="Send"]');
      if (!button || button.disabled) throw Error('Send unavailable');
      button.click();
    })()`);
    await waitForRendererCondition(harness, `!!document.querySelector('main[data-thread-session]')?.getAttribute('data-thread-session')`, "submitted card chat", { timeoutMs: 20_000 });
    const sessionId = await harness.renderer.evaluate<string>(`document.querySelector('main[data-thread-session]').getAttribute('data-thread-session')`);
    receipt.sessionId = sessionId;
    harness.recordMetadata({ method, sessionId, evidencePath, unchangedCardPrompt: receipt.prompt });
    await save();
    let cursor = 0;
    const observed = new Set<string>();
    const approvals = new Map<string, unknown>();
    const deadline = Date.now() + 1_140_000;
    while (Date.now() < deadline) {
      const page = await harness.api.eventPage<any>({ sessionId, afterSequence: cursor, limit: 500 });
      for (const entry of page.events ?? []) {
        const event = entry.event ?? entry;
        cursor = Math.max(cursor, event.sequence ?? 0);
        if (observed.has(event.id)) continue;
        observed.add(event.id);
        receipt.events.push(event);
        if (event.name === "approval.requested" && event.data?.id) approvals.set(event.data.id, event.data);
        if (event.name === "approval.resolved" && event.data?.approvalId) approvals.delete(event.data.approvalId);
        if (["turn.completed", "turn.failed", "turn.error", "turn.interrupted"].includes(event.name)) receipt.completed = event;
      }
      receipt.pendingApprovals = [...approvals.values()];
      await save();
      if (receipt.completed) break;
      // Approval requests remain visible for exact review; never grant the session.
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }
    if (!receipt.completed) throw new Error("Card turn did not finish; retain and reconcile this session before retrying.");
    const completed = receipt.completed.name === "turn.completed" && receipt.completed.status === "completed";
    harness.recordAssertion("realAgentCompleted", completed);
    if (!completed) throw new Error(`Card turn ended with ${receipt.completed.name}.`);
    harness.recordAssertion("noStrandedApprovals", approvals.size === 0);
    if (approvals.size) throw new Error("The native round ended with unresolved RPC approvals; this does not prove question continuation.");
    await harness.screenshot(`${method}-unchanged-card-response`);
  },
});
