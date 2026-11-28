import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { pythonCorrectnessAuthoringFields } from "@openpond/evals/connected-evidence";
import { learningRef } from "openpond-sdk/learning";
import type { ResourceSetupDraft } from "@openpond/contracts/resource-setup";
import type { ClientConnection } from "../../api";
import { useErrorToast } from "../../app/AppToastContext";
import { AppDialog } from "../dialogs/AppDialog";
import { RewardEditor, type GraderModelChoice } from "../labs/learning/RewardEditor";
import { useLearningResource } from "../labs/learning/useLearningResources";
import type { DraftEditorHandle } from "../labs/useDraftNavigation";
import { createWorkspaceApi } from "../labs/workspace/workspace-api";
import { useWorkspaceLearningClient } from "../labs/workspace/useWorkspaceLearningClient";

type Pin = NonNullable<ResourceSetupDraft["managedGrader"]>;
type Scope = Pick<Pin, "accountKey" | "teamId" | "actorId">;
const kindByMethod = { "LLM judge": "model_judge", "Human assessment": "human", "Python correctness": "custom_verifier" } as const;

export default function GraderSetupWorkspaceReview({ connection, scope, method, selection, name, criterion, onChange, onClose }: {
  connection: ClientConnection;
  scope: Scope;
  method: Pin["method"];
  selection?: Pin;
  name?: string;
  criterion?: string;
  onChange(pin: Pin, values?: { name: string; criterion?: string }): void;
  onClose(): void;
}) {
  const { accountKey, teamId, actorId } = scope;
  const api = useMemo(() => createWorkspaceApi(connection, { accountKey, teamId, actorId, projectId: null }),
    [connection, accountKey, teamId, actorId]);
  const client = useWorkspaceLearningClient(api);
  const [starting] = useState(selection);
  const authoring = useLearningResource(client, "draft", starting?.draft?.id ?? null, starting?.draft?.revision);
  const published = useLearningResource(client, "reward", starting?.release?.id ?? null, starting?.release?.revision);
  const graderModels = useQuery({ queryKey: ["evaluation-workspace", api.key, "graderModels"],
    enabled: method === "LLM judge", queryFn: ({ signal }) => api.request<{ models: GraderModelChoice[] }>("graderModels", undefined, signal) });
  const close = useRef<DraftEditorHandle>(null);
  const requestClose = () => { if (close.current) close.current.requestClose(); else onClose(); };
  const verifiedDraft = authoring.resource?.targetKind === "reward" && authoring.resource.contentHash === starting?.draft?.contentHash
    ? authoring.resource : undefined;
  const verifiedRelease = published.resource?.contentHash === starting?.release?.contentHash ? published.resource : null;
  const valid = (!starting?.draft || verifiedDraft) && (!starting?.release || verifiedRelease);
  const loading = starting?.draft && !authoring.resource && !authoring.error ||
    starting?.release && !published.resource && !published.error;
  useErrorToast(authoring.error ?? published.error ?? graderModels.error ??
    (authoring.resource && !verifiedDraft || published.resource && !verifiedRelease ? "The Grader differs from its saved revision." : null));
  return <AppDialog ariaLabel="Workspace Grader review" className="training-dialog" onClose={requestClose}>
    <h2>{method}</h2>
    <div className="training-dialog-scroll-body">
    {valid ? <RewardEditor embedded closeRef={close} client={client} reward={verifiedRelease}
      authoringDraft={verifiedDraft} models={graderModels.data?.models ?? []} allowedKinds={[kindByMethod[method]]}
      initialFields={{
        ...(method === "Python correctness" ? pythonCorrectnessAuthoringFields() : {}),
        kind: kindByMethod[method], ...(name?.trim() ? { name: name.trim() } : {}),
        ...(criterion?.trim() ? { rubric: criterion.trim() } : {}),
      }}
      onDraftSaved={draft => onChange({ ...scope, method, release: starting?.release, draft: learningRef(draft) },
        { name: draft.fields.name, criterion: method === "Python correctness" ? undefined : draft.fields.rubric })}
      onSaved={(release, fields) => {
        onChange({ ...scope, method, release: learningRef(release) }, {
          name: release.name,
          criterion: method === "Python correctness" ? undefined : fields.rubric,
        });
        onClose();
      }}
      onClose={onClose} /> : loading ? <p role="status">Loading the Grader revision…</p>
      : <button type="button" className="training-button secondary" onClick={() => { authoring.refresh(); published.refresh(); }}>Retry Grader revision</button>}
    </div>
    <footer className="training-dialog-actions">
      <button className="training-button secondary" type="button" onClick={requestClose}>Return to prompt</button>
    </footer>
  </AppDialog>;
}
