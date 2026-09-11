import type { TaskEvidence } from "openpond-sdk/learning";
import { LearningJsonField, LearningValue } from "./LearningFields";

import { updateCorrectedOutput } from "./updateCorrectedOutput";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function MessageContent({ value }: { value: unknown }) {
  if (typeof value === "string") return <p className="learning-message-text">{value}</p>;
  if (Array.isArray(value)) return <>{value.map((part, index) => <div key={index}>{isRecord(part) && typeof part.text === "string" ? <p className="learning-message-text">{part.text}</p> : <LearningValue label="Content" value={part} />}</div>)}</>;
  return <LearningValue label="Content" value={value} />;
}

function ConversationValue({ value, label }: { value: Record<string, unknown>; label: string }) {
  const messages = Array.isArray(value.messages) ? value.messages : null;
  if (!messages) return <LearningValue label={label} value={value} />;
  const { messages: _messages, ...context } = value;
  return <><h2>{label}</h2><ol className="learning-conversation">{messages.map((message, index) => <li key={index}>
    {isRecord(message) ? <><h3>{typeof message.role === "string" ? message.role : "Message"}{typeof message.name === "string" ? ` · ${message.name}` : ""}</h3><MessageContent value={message.content} />
      {Object.entries(message).filter(([key]) => !["id", "role", "name", "content"].includes(key)).map(([key, item]) => <div className="learning-value" key={key}><h3>{key.replaceAll("_", " ")}</h3><pre>{typeof item === "string" ? item : JSON.stringify(item, null, 2)}</pre></div>)}</> : <MessageContent value={message} />}
  </li>)}</ol>{Object.keys(context).length ? <details><summary>Additional retained context</summary><LearningValue label="Context" value={context} /></details> : null}</>;
}

export function ReviewEvidenceView({ evidence }: { evidence: TaskEvidence }) {
  return <section className="learning-review-surface" aria-label="Retained conversation">
    <p className="learning-help">Showing the context retained with this attempt. Earlier messages or tool activity may not have been captured.</p>
    <ConversationValue label="Request and conversation" value={evidence.submission.input} />
    {evidence.submission.observedOutput ? <ConversationValue label="Observed response" value={evidence.submission.observedOutput} /> : <p>No response was retained for this attempt.</p>}
    {evidence.submission.assets.length ? <details><summary>Files and artifacts · {evidence.submission.assets.length}</summary>{evidence.submission.assets.map(asset => <LearningValue key={asset.id} label={asset.id} value={asset} />)}</details> : null}
  </section>;
}

export function ReviewCorrectionEditor({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { /* Keep invalid structured drafts editable. */ }
  const entries = isRecord(parsed) ? Object.entries(parsed) : [];
  const fields = entries.filter(([, item]) => typeof item === "string");
  if (fields.length) return <>{fields.map(([key, item]) => <label key={key}>{fields.length === 1 ? "Corrected answer" : key.replaceAll("_", " ")}<textarea aria-label={fields.length === 1 ? "Corrected answer" : key.replaceAll("_", " ")} rows={5} value={String(item)} onChange={event => onChange(JSON.stringify(updateCorrectedOutput(parsed as Record<string, unknown>, key, event.target.value), null, 2))} /></label>)}{fields.length !== entries.length ? <details><summary>Structured output and retained metadata</summary><LearningJsonField label="Complete corrected output" value={value} onChange={onChange} /></details> : null}</>;
  return <LearningJsonField label="Corrected answer" hint="Keep the task's output fields. Your correction can be saved before it passes an automated check." value={value} onChange={onChange} />;
}
