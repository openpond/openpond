import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { SessionUserQuestionSchema } from "@openpond/contracts";
import { canonicalJson } from "openpond-sdk/training";
import { desktopScenario } from "../../scripts/desktop-harness/scenario";
import { waitForRendererCondition } from "./helpers";

const Review = z.object({
  question: SessionUserQuestionSchema,
  optionId: z.string().min(1),
  maximumSpendUsd: z.number().positive().finite(),
}).strict();

// Manual paid-work boundary: answer one exact, already reviewed budget form
// in its original chat. Never add instructions, send another starter, grant
// tool approvals, or replay an answer after uncertain observation.
export default desktopScenario({
  name: "training-budget-continuation", mode: "attach", timeoutMs: 1_260_000,
  async run(harness) {
    const reviewOnly = process.env.OPENPOND_TRAINING_BUDGET_REVIEW_ONLY === "1";
    if (harness.launchMode !== "attach" || !reviewOnly && process.env.OPENPOND_ALLOW_REVIEWED_TRAINING_BUDGET !== "1"
      || !process.env.OPENPOND_TRAINING_BUDGET_REVIEW)
      throw new Error("Use the running Desktop with an explicitly authorized, exact budget review file.");
    const review = Review.parse(JSON.parse(await readFile(process.env.OPENPOND_TRAINING_BUDGET_REVIEW, "utf8")));
    const selected = review.question.options.find(option => option.id === review.optionId);
    const ceiling = `$${review.maximumSpendUsd}`;
    if (!selected || !selected.label.includes(ceiling) || !review.question.question.includes(ceiling))
      throw new Error("The reviewed option must explicitly name the authorized total USD ceiling.");
    const sessionId = review.question.sessionId, events: any[] = [], seen = new Set<string>();
    let cursor = 0;
    const evidence = { sessionId, questionId: review.question.id, optionId: review.optionId,
      maximumSpendUsd: review.maximumSpendUsd, unchangedOriginalChat: true, events,
      observations: [] as Array<{ at: string; error: string }> };
    const save = () => writeFile(path.join(harness.artifactsDir, "budget-continuation.private.json"), JSON.stringify(evidence, null, 2));
    async function read() {
      let failures = 0;
      for (;;) {
        try {
          const previousCursor = cursor;
          const page = await harness.api.eventPage<any>({ sessionId, afterSequence: cursor, limit: 500 });
          for (const entry of page.events ?? []) {
            const event = entry.event ?? entry;
            cursor = Math.max(cursor, event.sequence ?? 0);
            if (!seen.has(event.id)) { seen.add(event.id); events.push(event); }
          }
          await save();
          if ((page.events?.length ?? 0) < 500) return;
          if (cursor <= previousCursor) throw new Error("The retained event cursor did not advance; stop observation without replaying the answer.");
        } catch (cause) {
          evidence.observations.push({ at: new Date().toISOString(), error: String(cause) });
          await save();
          if (++failures >= 3) throw cause;
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }
    await read();
    const original = events.find(event => event.name === "user_question.asked" && event.data?.question?.id === review.question.id);
    if (!original || canonicalJson(SessionUserQuestionSchema.parse(original.data.question)) !== canonicalJson(review.question))
      throw new Error("The retained budget question differs from the exact reviewed form.");
    const resolution = () => events.find(event => ["user_question.answered", "user_question.dismissed"].includes(event.name)
      && event.data?.resolution?.questionId === review.question.id);
    if (resolution() && (resolution().name !== "user_question.answered" || resolution().data.resolution.optionId !== review.optionId))
      throw new Error("This question already has a different decision; do not override it.");
    if (!resolution() || reviewOnly) {
      await harness.renderer.selectSession(sessionId);
      const selector = `[data-notification-question=${JSON.stringify(review.question.id)}]`;
      await waitForRendererCondition(harness, `!!document.querySelector(${JSON.stringify(selector)})`, "the original budget question");
      await harness.screenshot("reviewed-budget-before-answer");
      if (reviewOnly) {
        harness.recordAssertion("originalReviewedQuestionRetained", true);
        harness.recordMetadata({ sessionId, questionId: review.question.id, reviewOnly: true, answered: Boolean(resolution()), trainingStarted: false });
        await save();
        return;
      }
      await harness.renderer.evaluate(`(() => {
        const card = document.querySelector(${JSON.stringify(selector)});
        const button = [...card.querySelectorAll('.user-question-options button')].find(button => button.querySelector('.user-question-option-copy > span')?.textContent.trim() === ${JSON.stringify(selected.label)});
        if (!button || button.disabled) throw Error('The exact reviewed budget option is unavailable');
        button.click();
      })()`);
    }
    const deadline = Date.now() + 1_140_000;
    let continuation: any;
    while (Date.now() < deadline) {
      await read();
      const answered = resolution();
      if (answered && (answered.name !== "user_question.answered" || answered.data.resolution.optionId !== review.optionId))
        throw new Error("The retained answer does not match this review.");
      // Admission can append turn.started before the answered projection. Bind
      // the new turn to its exact resolution instead of assuming event order.
      continuation = answered && events.find(event => event.name === "turn.started"
        && event.args?.userQuestionResolution?.questionId === review.question.id
        && event.args.userQuestionResolution.optionId === review.optionId);
      const completed = continuation && events.find(event => event.turnId === continuation.turnId
        && ["turn.completed", "turn.failed", "turn.interrupted", "turn.error"].includes(event.name));
      if (completed) {
        harness.recordMetadata({ continuationTurnId: continuation.turnId, terminalEvent: completed.name,
          terminalStatus: completed.status, trainingAcceptanceProven: false });
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    harness.recordAssertion("exactBudgetAnswerRetained", Boolean(resolution()));
    harness.recordAssertion("sameChatContinuedAutomatically", Boolean(continuation));
    if (!resolution() || !continuation) throw new Error("Retain this chat and reconcile its answer; do not click again after an observation timeout.");
    harness.recordMetadata({ sessionId, questionId: review.question.id, optionId: review.optionId,
      observerTimedOut: Date.now() >= deadline, continuationTurnId: continuation.turnId, trainingAcceptanceProven: false });
    await save();
    await harness.screenshot("budget-continuation-observed");
  },
});
