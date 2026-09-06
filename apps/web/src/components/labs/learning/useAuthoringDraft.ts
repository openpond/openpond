import { useState } from "react";
import { AuthoringDraftInputSchema, AuthoringDraftSchema, learningRef, sealLearningContent, type AuthoringDraft, type AuthoringDraftInput, type OpenPondLearningClient } from "openpond-sdk/learning";

export function useAuthoringDraft(initial: AuthoringDraft | null | undefined) {
  const [id] = useState(() => initial?.id ?? `draft-${crypto.randomUUID()}`);
  const [record, setRecord] = useState(initial ?? null);
  async function save(api: OpenPondLearningClient, value: Omit<AuthoringDraftInput, "id" | "editorVersion">) {
    const draft = AuthoringDraftInputSchema.parse({ ...value, id, editorVersion: "openpond.modelsEditor.v1" });
    if (record && JSON.stringify(record.fields) === JSON.stringify(draft.fields)) return record;
    const expectedRevision = record?.revision ?? 0;
    const operationId = `draft:${sealLearningContent({ draft, expectedRevision }).contentHash}`;
    const response = await api.command({ action: "save_draft", operationId, expectedRevision, draft });
    const saved = AuthoringDraftSchema.parse(response.resources[0]);
    setRecord(saved);
    return saved;
  }
  return { record, save, finalization: (draft: AuthoringDraft, release: { id: string; revision: number; contentHash: string }) => ({ draft: learningRef(draft), targetKind: draft.targetKind, release: learningRef(release) }) };
}
