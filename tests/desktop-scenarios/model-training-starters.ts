import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { desktopScenario } from "../../scripts/desktop-harness/scenario";
import { reloadRenderer, waitForRendererCondition } from "./helpers";

// Failure story: a training shortcut must preserve the user's scoped draft and
// attachment, submit the actual edited prompt only on Send, and retain its result.
// Manual live acceptance uses the existing Codex subscription, never a scripted
// provider. Training/serving execution is forbidden in the submitted fixture.
export default desktopScenario({
  name: "model-training-starters",
  mode: "packaged",
  timeoutMs: 900_000,
  async run(harness) {
    if (harness.launchMode !== "packaged") throw new Error("Use an exact prebuilt Desktop package.");
    const live = process.env.OPENPOND_STARTER_LIVE_ACCEPTANCE === "1";
    const evidence: Record<string, unknown>[] = [];
    const failures: string[] = [];
    const save = () => writeFile(path.join(harness.artifactsDir, "starter-evidence.json"), JSON.stringify(evidence, null, 2));
    const check = (name: string, passed: boolean) => {
      harness.recordAssertion(name, passed);
      if (!passed) failures.push(name);
    };
    await harness.renderer.assertText("Train a model with SFT");
    await harness.renderer.evaluate(`document.querySelector('[aria-label="Close get started"]')?.click()`);
    if (live) {
      const bootstrap = await harness.api.bootstrap<any>("ensureProfile=0&refreshCodex=1");
      if (!bootstrap.codex?.available || bootstrap.codex.authHealth !== "signed_in" || bootstrap.codex.account?.type !== "chatgpt") {
        evidence.push({ stage: "agent-admission", available: bootstrap.codex?.available, authHealth: bootstrap.codex?.authHealth, accountType: bootstrap.codex?.account?.type });
        await save();
        throw new Error("A signed-in Codex subscription is required; no paid API provider is allowed.");
      }
      const providers = await harness.api.fetchJson<any>("/v1/providers");
      const status = providers.statuses.codex;
      const model = process.env.OPENPOND_STARTER_MODEL ?? status.defaultModel;
      if (!status.modelIds.includes(model)) throw new Error("Codex's configured model is not in its live catalog.");
      const configuration = await harness.api.fetchJson<any>("/v1/configuration");
      await harness.api.fetchJson("/v1/configuration", { method: "POST", body: {
        action: "client-state", owner: configuration.clientState.owner,
        patch: { chatSelection: { provider: "codex", model }, chatMode: "chat" },
      } });
      harness.recordMetadata({ realAgent: true, scriptedProvider: false, model, provider: "codex", computeSpendCeiling: 0 });
      await reloadRenderer(harness);
      await harness.renderer.assertText("Train a model with SFT");
    }
    const inventory = await harness.renderer.evaluate<any[]>(`[...document.querySelectorAll('.model-training-starter')].map(b=>({text:b.textContent,disabled:b.disabled}))`);
    check("fourCardsPresent", inventory.length === 4);
    check("weightSpaceTruthfullyUnavailable", inventory[3].disabled && /Not available yet/.test(inventory[3].text));
    evidence.push({ stage: "inventory", inventory });
    const workdir = await mkdtemp(path.join(os.tmpdir(), "openpond-starter-acceptance-"));
    const sentinel = await harness.api.createSession<any>({ provider: "codex", title: harness.uniqueTitle("Starter scope sentinel"), cwd: workdir });
    await reloadRenderer(harness);
    await harness.renderer.assertText("Train a model with SFT");
    const fixture = JSON.stringify({ purpose: "Unreviewed local acceptance examples; never train or run evaluation", examples: [
      { input: "What is 2 + 2?", expected: "4", split: "train" },
      { input: "What is 3 + 2?", expected: "5", split: "validation" },
    ] }, null, 2);
    for (const [index, method] of ["sft", "grpo", "decision"].entries()) {
      await waitForRendererCondition(harness, `!!document.querySelector('.model-training-starter:not(:disabled)')`, "new-chat starter cards");
      const startedTurns = async () => {
        const page = await harness.api.eventPage<any>({limit: 500});
        return (page.events ?? page.items ?? []).map((entry: any) => entry.event ?? entry)
          .filter((event: any) => event.name === "turn.started").map((event: any) => event.id).sort();
      };
      const baselineTurns = await startedTurns();
      const prefix = `PREPARATION ONLY: ${method} starter acceptance. My total compute/API spending limit is $0. Do not run training, evaluation, serving, scheduling, tensor editing or any paid provider. Inspect the attached unreviewed arithmetic examples and explain which actual supported workflow this card requests, which inputs still need review/selection, and the next free preparation step. Do not invent accepted preparations, resource IDs, costs or completed operations. Do not inspect or change application repository source. Stop after reporting the missing inputs.\n\n`;
      await harness.renderer.replaceComposerText!(prefix);
      await harness.renderer.evaluate(`(() => {
        const data=new DataTransfer();data.items.add(new File([${JSON.stringify(fixture)}],${JSON.stringify(`${method}-examples.json`)},{type:'application/json'}));
        const input=document.querySelector('form.composer input[type="file"]:not([webkitdirectory])');
        if(!input)throw Error('Attachment input missing');input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}));
      })()`);
      await waitForRendererCondition(harness, `document.querySelector('.composer-attachment-card')?.textContent?.includes(${JSON.stringify(`${method}-examples.json`)})`, "fixture attachment");
      const initialModel = await harness.renderer.evaluate<string>(`document.querySelector('.codex-model-trigger')?.textContent ?? ''`);
      await harness.renderer.evaluate(`document.querySelectorAll('.model-training-starter')[${index}].click()`);
      const prompt = await harness.renderer.evaluate<string>(`document.querySelector('.composer-inline-input')?.innerText ?? ''`);
      check(`${method}:existingDraftPreserved`, prompt.startsWith(prefix.trimEnd()));
      check(`${method}:cardAddedPrompt`, prompt.length > prefix.length && /selected resources/.test(prompt));
      await harness.renderer.evaluate(`document.querySelectorAll('.model-training-starter')[${index}].click()`);
      check(`${method}:repeatClickDoesNotDuplicate`, prompt === await harness.renderer.evaluate(`document.querySelector('.composer-inline-input')?.innerText ?? ''`));
      check(`${method}:attachmentPreserved`, await harness.renderer.evaluate(`!!document.querySelector('.composer-attachment-card')?.textContent?.includes(${JSON.stringify(`${method}-examples.json`)})`));
      check(`${method}:answeringModelPreserved`, initialModel === await harness.renderer.evaluate(`document.querySelector('.codex-model-trigger')?.textContent ?? ''`));
      check(`${method}:clickDoesNotSend`, JSON.stringify(await startedTurns()) === JSON.stringify(baselineTurns));
      const beforeDisabled = prompt;
      await harness.renderer.evaluate(`document.querySelectorAll('.model-training-starter')[3].click()`);
      check(`${method}:disabledCardDoesNotChangeDraft`, beforeDisabled === await harness.renderer.evaluate(`document.querySelector('.composer-inline-input')?.innerText ?? ''`));
      if (index === 0) {
        await harness.renderer.selectSession(sentinel.id);
        check("otherChatDoesNotReceiveDraft", await harness.renderer.evaluate(`!document.querySelector('.composer-inline-input')?.textContent?.includes('starter acceptance')`));
        await harness.renderer.evaluate(`document.querySelector('button[aria-label="New thread"]')?.click()`);
        await waitForRendererCondition(harness, `!!document.querySelector('.model-training-starter')`, "return to start");
        check("returnToScopeRestoresDraft", prompt === await harness.renderer.evaluate(`document.querySelector('.composer-inline-input')?.innerText ?? ''`));
        check("returnToScopeRestoresAttachment", await harness.renderer.evaluate(`!!document.querySelector('.composer-attachment-card')?.textContent?.includes('sft-examples.json')`));
        // Keep collecting all actual agent outcomes on the released version even
        // if this regression is present; the failed assertion remains in report.
        await harness.renderer.evaluate(`(() => {
          if(document.querySelector('.composer-attachment-card'))return;
          const data=new DataTransfer();data.items.add(new File([${JSON.stringify(fixture)}],'sft-examples.json',{type:'application/json'}));
          const input=document.querySelector('form.composer input[type="file"]:not([webkitdirectory])');
          input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}));
        })()`);
      }
      const entry: Record<string, unknown> = { method, prompt, attachedFixture: fixture, clickedButUnsent: true };
      evidence.push(entry);
      await save();
      await harness.screenshot(`${method}-editable-draft`);
      if (live) {
        await harness.renderer.evaluate(`(() => { const button=document.querySelector('form.composer button[aria-label="Send"]');if(!button||button.disabled)throw Error('Send unavailable');button.click(); })()`);
        await waitForRendererCondition(harness, `!!document.querySelector('main[data-thread-session]')?.getAttribute('data-thread-session')`, "submitted chat identity");
        const sessionId = await harness.renderer.evaluate<string>(`document.querySelector('main[data-thread-session]').getAttribute('data-thread-session')`);
        entry.sessionId = sessionId;
        await save();
        const startedAt = Date.now();
        let completed: any;
        while (Date.now() - startedAt < 240_000) {
          const state = await harness.api.bootstrap<any>();
          completed = state.events?.find((event: any) => ["turn.completed", "turn.failed", "turn.error"].includes(event.name) && event.sessionId === sessionId);
          if (completed) break;
          const approvals = state.approvals?.filter((approval: any) => approval.sessionId === sessionId) ?? [];
          for (const approval of approvals) {
            const command = approval.title;
            const localContextRead = [
              '"$OPENPOND_CLI_NODE" "$OPENPOND_CLI_ENTRY" datasets context --local --json',
              '"$OPENPOND_CLI_NODE" "$OPENPOND_CLI_ENTRY" datasets list --local --json',
              '"$OPENPOND_CLI_NODE" "$OPENPOND_CLI_ENTRY" datasets list-graders --local --json',
              '"$OPENPOND_CLI_NODE" "$OPENPOND_CLI_ENTRY" training projects --json',
              '"$OPENPOND_CLI_NODE" "$OPENPOND_CLI_ENTRY" account --json',
              '"$OPENPOND_CLI_NODE" "$OPENPOND_CLI_ENTRY" account context --json',
            ].includes(command);
            const cliHelp = /^"\$OPENPOND_CLI_NODE" "\$OPENPOND_CLI_ENTRY" (?:training|datasets|learning|models)(?: [a-z-]+)* --help$/.test(command);
            if (!localContextRead && !cliHelp) {
              const denied = (entry.deniedApprovals ?? []) as unknown[];
              if (!denied.some((value: any) => value.id === approval.id)) denied.push({ id: approval.id, title: approval.title, kind: approval.kind });
              entry.deniedApprovals = denied;
              await save();
            }
            await harness.renderer.evaluate(`(() => {
              const shell=[...document.querySelectorAll('[data-notification-approval]')].find(node=>node.getAttribute('data-notification-approval')===${JSON.stringify(approval.id)});
              const button=shell?.querySelector(${JSON.stringify(localContextRead || cliHelp ? ".approval-action.primary" : ".approval-action.muted")});if(button&&!button.disabled)button.click();
            })()`);
          }
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        if (!completed) throw new Error(`${method} agent did not finish within the bounded fixture deadline.`);
        const page = await harness.api.eventPage<any>({ sessionId: completed.sessionId, limit: 500 });
        const events = (page.events ?? page.items ?? []).map((value: any) => value.event ?? value);
        entry.sessionId = completed.sessionId; entry.turnId = completed.turnId; entry.status = completed.status;
        entry.events = events;
        entry.renderedConversation = await harness.renderer.evaluate(`document.querySelector('.chat-thread')?.innerText ?? ''`);
        await save();
        check(`${method}:realAgentCompleted`, completed.status === "completed");
        const toolStarts = events.filter((event: any) => event.name === "tool.started" || event.name === "tool.requested");
        const commands = JSON.stringify(toolStarts);
        check(`${method}:noComputeStartAttempt`, !/hosted-(?:start-|control-weight-space-serving|worker-resume|base-serving-prepare)/.test(commands));
        await reloadRenderer(harness);
        await harness.renderer.selectSession(completed.sessionId!);
        await harness.screenshot(`${method}-agent-result-reopened`);
      } else {
        await harness.renderer.replaceComposerText!("");
        await harness.renderer.evaluate(`document.querySelector('.composer-attachment-card button[aria-label^="Remove"]')?.click()`);
      }
      if (live) await harness.renderer.evaluate(`document.querySelector('button[aria-label="New thread"]')?.click()`);
    }
    await save();
    harness.recordMetadata({ evidencePath: path.join(harness.artifactsDir, "starter-evidence.json"), acceptedPreparationProven: false,
      fourthCardSubmission: "Unavailable in released cohort; no prompt exists", scopeSentinelSession: sentinel.id });
    if (failures.length) throw new Error(`Training starter boundaries failed: ${failures.join(", ")}`);
  }
});
