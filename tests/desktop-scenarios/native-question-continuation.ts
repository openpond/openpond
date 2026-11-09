import { writeFile } from "node:fs/promises";
import path from "node:path";
import { desktopScenario } from "../../scripts/desktop-harness/scenario";
import { reloadRenderer, waitForRendererCondition } from "./helpers";

// Manual live-agent boundary: a persisted question must survive the native
// round/reload, and one answer must automatically continue the same chat.
// This has no training, external mutation or paid compute authority.
export default desktopScenario({
  name: "native-question-continuation", mode: "attach", timeoutMs: 600_000,
  async run(h) {
    if (h.launchMode !== "attach") throw new Error("Use an authenticated running Desktop with --attach.");
    const providers = await h.api.fetchJson<any>("/v1/providers");
    if (!providers.statuses.codex?.modelIds.includes("gpt-6.1-sol")) throw new Error("GPT-6.1 Sol must be available in the installed agent.");
    const configuration = await h.api.fetchJson<any>("/v1/configuration");
    await h.api.fetchJson("/v1/configuration", { method: "POST", body: { action: "client-state", owner: configuration.clientState.owner,
      patch: { chatSelection: { provider: "codex", model: "gpt-6.1-sol" }, chatMode: "chat" } } });
    await reloadRenderer(h);
    await waitForRendererCondition(h, `!!document.querySelector('button[aria-label="New thread"]')`, "new chat action");
    await h.renderer.evaluate(`document.querySelector('button[aria-label="New thread"]').click()`);
    await waitForRendererCondition(h, `!!document.querySelector('.model-training-starter')`, "empty chat");
    if ((await h.renderer.evaluate<string>(`document.querySelector('.composer-inline-input')?.innerText ?? ''`)).trim())
      throw new Error("Preserve the existing draft before this manual acceptance.");
    await h.renderer.replaceComposerText!("Ask me whether to return Markdown or JSON using the app's question form. Once I answer, return an example in that format.");
    await h.renderer.evaluate(`document.querySelector('form.composer button[aria-label="Send"]').click()`);
    await waitForRendererCondition(h, `!!document.querySelector('main[data-thread-session]')?.getAttribute('data-thread-session')`, "submitted question chat");
    const sessionId = await h.renderer.evaluate<string>(`document.querySelector('main[data-thread-session]').getAttribute('data-thread-session')`);
    const events: any[] = [], seen = new Set<string>();
    let cursor = 0;
    const save = () => writeFile(path.join(h.artifactsDir, "question-continuation.private.json"), JSON.stringify({ sessionId, events }, null, 2));
    const observe = async (condition: () => boolean) => {
      const deadline = Date.now() + 240_000;
      while (Date.now() < deadline) {
        const page = await h.api.eventPage<any>({ sessionId, afterSequence: cursor, limit: 500 });
        for (const row of page.events ?? []) {
          const event = row.event ?? row;
          cursor = Math.max(cursor, event.sequence ?? 0);
          if (!seen.has(event.id)) { seen.add(event.id); events.push(event); }
        }
        await save();
        if (condition()) return;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      throw new Error("Question continuation did not reach the expected boundary; retain this original chat.");
    };
    await observe(() => events.some(e => e.name === "user_question.asked") && events.some(e => e.name === "turn.completed"));
    const question = events.find(e => e.name === "user_question.asked").data.question;
    const json = question.options.find((option: any) => /json/i.test(option.label));
    if (!json) throw new Error("The real agent did not offer JSON as requested.");
    await reloadRenderer(h);
    await waitForRendererCondition(h, `!!document.querySelector('[data-notification-question=${JSON.stringify(question.id)}]')`, "persisted question after reload");
    await h.screenshot("question-after-native-round-and-reload");
    const firstTurn = question.turnId;
    await h.renderer.evaluate(`(() => { const card = document.querySelector('[data-notification-question=${JSON.stringify(question.id)}]'); const button = [...card.querySelectorAll('.user-question-options button')].find(b=>b.textContent.includes(${JSON.stringify(json.label)})); if (!button || button.disabled) throw Error('Question answer unavailable'); button.click(); })()`);
    await observe(() => events.some(e => e.name === "user_question.answered") && events.some(e => e.name === "turn.completed" && e.turnId !== firstTurn));
    const answered = events.find(e => e.name === "user_question.answered").data.resolution;
    h.recordAssertion("exactQuestionAnswered", answered.questionId === question.id && answered.optionId === json.id);
    h.recordAssertion("automaticSameChatContinuation", events.some(e => e.name === "turn.started" && e.turnId !== firstTurn));
    h.recordAssertion("continuationProducedResponse", events.some(e => e.name === "assistant.delta" && e.turnId !== firstTurn && e.output?.trim()));
    h.recordMetadata({ sessionId, firstTurn, questionId: question.id, liveAgent: true, mockedProvider: false, trainingStarted: false });
    await h.screenshot("answer-continued-the-same-chat");
  },
});
