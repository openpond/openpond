import { useRef, useState } from "react";
import { ZodError } from "zod";
import { canonicalJson, parseDecisionFormScoring, type DecisionExperimentFormDraft } from "openpond-sdk/training";
import type { ComposerDraftStore } from "../../lib/composer-draft-store";
import { DecisionChatDraftSchema, DecisionChatInputSchema, decisionChatDraftFromInput, decisionChatPromptForDisplay, type DecisionChatDraft } from "../../lib/decision-chat-draft";
import { modelOptionsForProvider, providerOptionsFromSettings } from "../../lib/app-models";
import { ErrorToast } from "../common/ErrorToast";
import { DecisionScoringFields } from "../labs/workspace/DecisionFields";
import { initialDecisionForm } from "../labs/workspace/decision-form-defaults";
import { ComposerModelMenu } from "./ComposerControls";
import { composerModelGroups } from "./composer-model-options";
import { ComposerSubmissionControls } from "./ComposerSubmissionControls";
import type { ComposerProps } from "./composer-types";
import { NativeConversationUnavailable, useNativeConversationAvailability } from "./NativeConversationAvailability";
import "../../styles/training/training.css";
import "../../styles/labs/evaluation-workspace.css";
import "./decision-chat-composer.css";

type ScoreForm = Extract<DecisionExperimentFormDraft, { mode: "score" }>;
type Props = Omit<ComposerProps, "onPromptChange"> & { draftStore: ComposerDraftStore };

function emptyForm(): ScoreForm {
  const form = initialDecisionForm("score") as ScoreForm;
  return { ...form, questions: form.questions.map((question, index) => ({ ...question, id: `question_${index + 1}` })) };
}
function draftFromForm(form: ScoreForm) {
  return DecisionChatDraftSchema.parse({ stateJson: form.stateJson, questions: form.questions, limits: form.limits });
}
function inputError(cause: unknown) {
  if (!(cause instanceof ZodError)) return cause;
  const issue = cause.issues[0];
  if (!issue) return new Error("Review the context, questions and allowed answers before scoring.");
  if (issue.path[0] === "questions" && typeof issue.path[1] === "number") {
    const question = `Question ${issue.path[1] + 1}`;
    if (issue.path[2] === "description") return new Error(`${question} needs a question to score.`);
    if (issue.path[2] === "choices") return new Error(`${question} needs distinct, nonempty answers that match its answer type.`);
  }
  if (issue.path[0] === "maximumPromptTokens" || issue.path[0] === "maximumForwardTokenWork" || issue.path[0] === "maximumDurationSeconds")
    return new Error("Review Scoring limits and enter a supported positive number for each limit.");
  return new Error("Review the context, questions and allowed answers before scoring.");
}

/** A dedicated input mode for a typed candidate scorer. Free-form drafts and
 * unfinished Decision input remain separate across model/task switches. */
export function DecisionChatComposer(props: Props) {
  const scopeKey = props.draftStore.getScopeKey(), modelId = props.model;
  const [draft, setDraft] = useState<DecisionChatDraft>(() => props.draftStore.getDecisionDraft(scopeKey, modelId) ?? draftFromForm(emptyForm()));
  const [error, setError] = useState<unknown>(null), [submitting, setSubmitting] = useState(false);
  const native = useNativeConversationAvailability({ connection: props.connection, sessionId: props.taskSessionId ?? props.readOnlySession?.id ?? null,
    events: props.taskEvents ?? [], fallbackReason: props.readOnlyReason ?? null, fallbackSession: props.readOnlySession });
  const submittingRef = useRef(false);
  const form: ScoreForm = { ...emptyForm(), ...draft };
  const disabled = props.busy || submitting || Boolean(props.running) || Boolean(native.reason) || !props.connection;
  const modelOptions = modelOptionsForProvider(props.provider, props.providerSettings);
  const groups = composerModelGroups({ currentModelOptions: modelOptions, currentProvider: props.provider,
    providerOptions: providerOptionsFromSettings(props.providerSettings, { enabledOnly: true }), providerSettings: props.providerSettings });
  const lastInput = [...(props.taskEvents ?? [])].reverse().find(event => {
    const ref = event.args?.modelRef as { providerId?: unknown; modelId?: unknown } | undefined;
    return event.name === "turn.started" && ref?.providerId === "openpond" && ref.modelId === modelId && typeof event.args?.prompt === "string";
  })?.args?.prompt;
  let previous: DecisionChatDraft | null = null;
  if (typeof lastInput === "string" && new TextEncoder().encode(lastInput).byteLength <= 131_072) {
    try { previous = decisionChatDraftFromInput(JSON.parse(lastInput)); } catch { /* Invalid historical input stays visible in the transcript. */ }
  }
  function change(next: DecisionChatDraft) {
    props.draftStore.setDecisionDraftForScope(scopeKey, modelId, next);
    setDraft(next); setError(null);
  }
  async function submit() {
    if (disabled || submittingRef.current) return;
    if (props.draftStore.getScopeKey() !== scopeKey || props.getCurrentSubmissionScopeKey && props.submissionScopeKey
      && props.getCurrentSubmissionScopeKey() !== props.submissionScopeKey) return;
    submittingRef.current = true; setSubmitting(true); setError(null);
    const submitted = canonicalJson(draft);
    try {
      const authored = { ...form, questions: form.questions.map(question => ({ ...question,
        choices: question.choices.map(choice => ({ ...choice, description: choice.description || choice.value })),
      })) };
      const payload = DecisionChatInputSchema.parse(parseDecisionFormScoring(authored)), prompt = canonicalJson(payload);
      if (new TextEncoder().encode(prompt).byteLength > 131_072) throw new Error("Reduce the context or allowed answers to fit this model's input limit.");
      const sent = await props.onSubmit([], null, null, { preservePrompt: true, promptOverride: prompt,
        displayPrompt: decisionChatPromptForDisplay("openpond", modelId, prompt) });
      if (sent) {
        const current = props.draftStore.getDecisionDraft(scopeKey, modelId);
        if (!current || canonicalJson(current) === submitted) {
          props.draftStore.setDecisionDraftForScope(scopeKey, modelId, null);
          setDraft(draftFromForm(emptyForm()));
        }
      }
    } catch (cause) { setError(inputError(cause)); }
    finally { submittingRef.current = false; setSubmitting(false); }
  }
  if (native.reason) return <NativeConversationUnavailable connection={props.connection} session={native.session}
    reason={native.reason} onRechecked={native.acceptSession} onOpenParent={props.onOpenNativeParent} />;

  return <form className={`composer ${props.mode} decision-chat-composer`} aria-label="Decision Model input" onSubmit={event => { event.preventDefault(); void submit(); }}>
    <ErrorToast error={error} />
    <div className="composer-textarea-frame decision-chat-frame">
      <div className="decision-chat-fields">
        <header><strong>Score allowed answers</strong>{previous ? <button type="button" className="training-text-button" disabled={disabled} onClick={() => { if (previous) change(previous); }}>Use previous input</button> : null}</header>
        <fieldset disabled={disabled}><DecisionScoringFields compact form={form} onChange={next => change(draftFromForm(next))} /></fieldset>
      </div>
      <div className="decision-chat-controls">
        <ComposerModelMenu disabled={Boolean(props.modelSelectionDisabled) || submitting || Boolean(props.running)} model={modelId} modelGroups={groups}
          placement={props.mode === "start" ? "bottom" : "top"} provider={props.provider} providerSettings={props.providerSettings}
          reasoningEffort={props.codexReasoningEffort} showReasoning={false}
          onReasoningEffortChange={props.onCodexReasoningEffortChange}
          onModelSelectionChange={(provider, model) => { if (provider === props.provider) props.onModelChange(model); else props.onProviderChange(provider, model); }} />
        <ComposerSubmissionControls running={Boolean(props.running)} sendDisabled={disabled} hasComposerInput={!props.running}
          sendTooltip={submitting ? "Sending score request" : "Score answers"} stopIcon="stop" stopLabel="Stop response" voiceInputActive={false}
          onSend={() => void submit()} onStop={props.onStop} />
      </div>
    </div>
  </form>;
}
