import { useState } from "react";
import { learningRef, TaskEvidenceSchema, TaskExampleSubmissionSchema, sameLearningRef, validateSourceSubmission, type OpenPondLearningClient, type TaskDefinition } from "openpond-sdk/learning";
import { assertBoundedTaskJson } from "@openpond/evals/task-schema";
import { useDraftNavigation } from "../useDraftNavigation";
import { LearningActions, LearningError, LearningJsonField } from "./LearningFields";
import { useLearningMutation } from "./useLearningResources";

export function LearningIntake({ client, definition, onReview }: { client: OpenPondLearningClient | null; definition: TaskDefinition; onReview: (id: string) => void }) {
  const [initial] = useState(() => JSON.stringify({ schemaVersion: "openpond.taskExample.v1", sourceId: `${definition.id}-direct`, idempotencyKey: `example-${crypto.randomUUID()}`, taskDefinition: learningRef(definition), exampleId: "your-record-id", attemptId: "attempt-1", occurredAt: new Date().toISOString(), familyKey: "your-family-id", split: "train", input: {}, observedOutput: null, expected: null, evaluatorContext: null, assets: [], provenance: { sourceRecordRef: null, mappingHash: null } }, null, 2));
  const [draft, setDraft] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [receipts, setReceipts] = useState<Array<{ row: number; id: string; revision: number }>>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const mutation = useLearningMutation(client);
  async function submit() {
    return mutation.run(async (api) => {
      if (new TextEncoder().encode(draft).byteLength > 8_388_608) throw new Error("Import at most 8 MiB at a time.");
      let parsed: unknown;
      try { parsed = JSON.parse(draft); }
      catch { parsed = draft.split(/\r?\n/u).filter((line) => line.trim()).map((line, index) => { try { return JSON.parse(line) as unknown; } catch { throw new Error(`Line ${index + 1} is not valid JSON.`); } }); }
      assertBoundedTaskJson(parsed, 8_388_608);
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      if (!rows.length || rows.length > 100) throw new Error("Submit between 1 and 100 examples per import. The SDK supports larger feeds through individual idempotent submissions.");
      const examples = rows.map((row, index) => {
        const parsed = TaskExampleSubmissionSchema.safeParse(row);
        if (!parsed.success) throw new Error(`Row ${index + 1}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
        if (!sameLearningRef(parsed.data.taskDefinition, learningRef(definition))) throw new Error(`Row ${index + 1} references a different task format release.`);
        return parsed.data;
      });
      // Validate every source before committing the first row. Transient failures can
      // still leave a partial import; original producer keys make a retry safe.
      const sources = await Promise.all([...new Set(examples.map((example) => example.sourceId))].map((id) => api.get("source", id)));
      for (const example of examples) validateSourceSubmission(sources.find((source) => source.id === example.sourceId)!, example);
      setReceipts([]);
      for (const [index, example] of examples.entries()) {
        const evidence = TaskEvidenceSchema.parse((await api.submitExample(example)).resources[0]);
        setReceipts((receipts) => [...receipts, { row: index + 1, id: evidence.id, revision: evidence.revision }]);
      }
      setSaved(draft);
      return true;
    });
  }
  const guard = useDraftNavigation({ name: "examples", dirty: draft !== saved, busy: mutation.busy, save: async () => Boolean(await submit()) });
  return <section className="learning-intake">
    <h2>Submit examples</h2><p>Fill in the task input and stable record, attempt, and family IDs. Observed output, expected answer, and evaluator context stay separate. Saved examples enter review; importing does not approve them for training.</p>
    <LearningError error={mutation.error ?? fileError} />
    <label>Import JSON or JSONL<input type="file" accept=".json,.jsonl,application/json" disabled={mutation.busy} onChange={async (event) => {
      const file = event.target.files?.[0]; if (!file) return;
      setFileError(null);
      try { if (file.size > 8_388_608) throw new Error("Select a file of at most 8 MiB."); setDraft(await file.text()); } catch (error) { setFileError(error instanceof Error ? error.message : String(error)); }
      event.target.value = "";
    }} /></label>
    <LearningJsonField label="Example envelope or JSONL records" hint="Use a JSON object, an array, or one object per line. Retry a partial import with its original idempotency keys." value={draft} onChange={setDraft} disabled={mutation.busy} />
    <LearningActions><button className="training-button" type="button" disabled={mutation.busy || !draft.trim()} onClick={() => { void submit(); }}>{mutation.busy ? `Importing (${receipts.length} saved)…` : "Submit for review"}</button></LearningActions>
    {receipts.length ? <div role="status"><p>{receipts.length} examples saved.</p><ul>{receipts.map((receipt) => <li key={receipt.row}><button type="button" className="labs-version-row-button" onClick={() => onReview(receipt.id)}>Review row {receipt.row} · evidence release {receipt.revision}</button></li>)}</ul></div> : null}
    <details><summary>Submit from your application</summary><p>Save the complete envelope above as example.json, install openpond-sdk, and run this TypeScript with Node. Preserve the record and its idempotency key on retries.</p><pre>{`import { readFile } from "node:fs/promises";
import { OpenPondLearningClient, TaskExampleSubmissionSchema } from "openpond-sdk/learning";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error("Set " + name);
  return value;
}

const learning = new OpenPondLearningClient({
  baseUrl: required("OPENPOND_API_URL"),
  apiKey: required("OPENPOND_API_KEY"),
  scope: required("OPENPOND_LEARNING_SCOPE"),
});
const example = TaskExampleSubmissionSchema.parse(
  JSON.parse(await readFile("example.json", "utf8")),
);
const receipt = await learning.submitExample(example);
console.log(receipt.operationId);
// Retain sourceId, exampleId and attemptId for late feedback.`}</pre></details>
    {guard.dialog}
  </section>;
}
