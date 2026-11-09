import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { canonicalJson } from "openpond-sdk/training";
import { desktopScenario } from "../../scripts/desktop-harness/scenario";

const Review = z.object({
  sessionId: z.string().min(1), previousTurnId: z.string().min(1),
  approvedQuestionId: z.string().min(1), approvedOptionId: z.string().min(1),
  maximumSpendUsd: z.number().positive().finite(), prompt: z.string().trim().min(1).max(4000),
}).strict();

// Manual actual-provider recovery: a prior budget answer remains the authority.
// Journal the single Send attempt before clicking. Observation failure must
// never resubmit it, answer another question, or replace a paid operation ID.
export default desktopScenario({
  name: "training-conversation-continuation", mode: "attach", timeoutMs: 1_260_000,
  async run(harness) {
    const reviewFile = process.env.OPENPOND_TRAINING_CONTINUATION_REVIEW;
    const receiptFile = process.env.OPENPOND_TRAINING_CONTINUATION_RECEIPT;
    const readOnly = process.env.OPENPOND_TRAINING_CONTINUATION_READ_ONLY === "1";
    if (harness.launchMode !== "attach" || !reviewFile || !receiptFile
      || !path.isAbsolute(receiptFile) || !readOnly && process.env.OPENPOND_ALLOW_REVIEWED_TRAINING_CONTINUATION !== "1")
      throw new Error("Attach to the original Desktop with its reviewed continuation and stable absolute receipt path.");
    const review = Review.parse(JSON.parse(await readFile(reviewFile, "utf8")));
    const reviewHash = createHash("sha256").update(canonicalJson(review)).digest("hex");
    let retained: { reviewHash: string; submissionAttempted: boolean } | null = null;
    try { retained = JSON.parse(await readFile(receiptFile, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (retained && retained.reviewHash !== reviewHash) throw new Error("The retained continuation belongs to a different review.");
    const events: any[] = [], seen = new Set<string>();
    let cursor = 0;
    const evidence = { ...review, reviewHash, submissionAttempted: retained?.submissionAttempted ?? false,
      events, observations: [] as Array<{ at: string; error: string }> };
    const save = async () => {
      await writeFile(receiptFile, JSON.stringify({ reviewHash, submissionAttempted: evidence.submissionAttempted }, null, 2), { mode: 0o600 });
      await writeFile(path.join(harness.artifactsDir, "continuation.private.json"), JSON.stringify(evidence, null, 2));
    };
    async function read() {
      let failures = 0;
      for (;;) {
        try {
          const previous = cursor;
          const page = await harness.api.eventPage<any>({ sessionId: review.sessionId, afterSequence: cursor, limit: 500 });
          for (const entry of page.events ?? []) {
            const event = entry.event ?? entry;
            cursor = Math.max(cursor, entry.sequence ?? event.sequence ?? 0);
            if (!seen.has(event.id)) { seen.add(event.id); events.push(event); }
          }
          if ((page.events?.length ?? 0) < 500) return;
          if (cursor <= previous) throw new Error("Retained event cursor stopped advancing.");
        } catch (error) {
          evidence.observations.push({ at: new Date().toISOString(), error: String(error) });
          await save();
          if (++failures >= 3) throw error;
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }
    await read();
    const question = events.find(event => event.name === "user_question.asked" && event.data?.question?.id === review.approvedQuestionId);
    const answer = events.find(event => event.name === "user_question.answered" && event.data?.resolution?.questionId === review.approvedQuestionId
      && event.data.resolution.optionId === review.approvedOptionId);
    const prior = events.find(event => event.turnId === review.previousTurnId && event.name === "turn.completed");
    if (!question || !answer || !prior) throw new Error("Original budget answer and completed setup turn must remain available.");
    const continuation = () => events.find(event => event.name === "turn.started" && event.sequence > prior.sequence && event.args?.prompt === review.prompt);
    await save();
    if (readOnly) {
      harness.recordAssertion("originalApprovalAndTerminalSetupRetained", true);
      harness.recordMetadata({ readOnly: true, sessionId: review.sessionId, continuationTurnId: continuation()?.turnId ?? null, trainingAcceptanceProven: false });
      return;
    }
    if (!continuation() && !evidence.submissionAttempted) {
      const bootstrap = await harness.api.bootstrap<any>();
      if (bootstrap.sessions.find((session: any) => session.id === review.sessionId)?.status === "active")
        throw new Error("The original chat already has active work; observe it without another Send.");
      await harness.renderer.selectSession(review.sessionId);
      const draft = await harness.renderer.evaluate<{ session: string | null; text: string }>(`({session:document.querySelector('main[data-thread-session]')?.getAttribute('data-thread-session')??null,text:document.querySelector('.composer-inline-input')?.innerText??''})`);
      if (draft.session !== review.sessionId || draft.text.trim() && draft.text.trim() !== review.prompt)
        throw new Error("Preserve the current chat and edited draft; do not replace it with the reviewed continuation.");
      await harness.renderer.replaceComposerText!(review.prompt);
      evidence.submissionAttempted = true;
      await save();
      await harness.renderer.evaluate(`(() => { const b=document.querySelector('form.composer button[aria-label="Send"]'); if(document.querySelector('main[data-thread-session]')?.getAttribute('data-thread-session')!==${JSON.stringify(review.sessionId)}||document.querySelector('.composer-inline-input')?.innerText.trim()!==${JSON.stringify(review.prompt)}||!b||b.disabled)throw Error('Original chat or reviewed draft changed before Send'); b.click(); })()`);
    }
    const deadline = Date.now() + 1_140_000;
    while (Date.now() < deadline) {
      await read(); await save();
      const started = continuation();
      const terminal = started && events.find(event => event.turnId === started.turnId
        && ["turn.completed", "turn.failed", "turn.interrupted", "turn.error"].includes(event.name));
      if (terminal) {
        harness.recordAssertion("sameChatContinuationRetained", true);
        harness.recordMetadata({ sessionId: review.sessionId, continuationTurnId: started.turnId,
          terminalEvent: terminal.name, terminalStatus: terminal.status, maximumSpendUsd: review.maximumSpendUsd,
          trainingAcceptanceProven: false });
        await harness.screenshot("continued-training-chat");
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error("Continue observing this same chat and receipt; observation timeout never authorizes another Send.");
  },
});
