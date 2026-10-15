import { ErrorToast } from "../common/ErrorToast";
import { resourceIdentity } from "./dataset-workspace-data";
import { useState } from "react";
import type { ClientConnection } from "../../api";
import type { RuntimeEvent } from "@openpond/contracts";
import { useChatContextSelection } from "../../hooks/useChatContextSelection";
import { useChatResourceFocus } from "../../hooks/useChatResourceFocus";
import { modelsLocation, modelsPath } from "../labs/models-route";
import { DropdownSelect } from "../DropdownSelect";
import { ChatContextPicker } from "./ChatContextPicker";
import { DatasetWorkspace } from "./DatasetWorkspace";
import { ModelTrainingJourney } from "../labs/ModelTrainingJourney";
import { LocalTrainingOverview } from "./DatasetTrainingOverview";

export function ChatExperimentTool({ connection, sessionId, events }: { connection: ClientConnection; sessionId: string | null; events: RuntimeEvent[] }) {
  const context = useChatContextSelection(connection, sessionId);
  const resources = useChatResourceFocus(connection, sessionId);
  const [error, setError] = useState<string | null>(null);
  const selected = context.selection, training = selected?.training;
  const focused = selected?.resource?.kind === "dataset" ? resources.focus.dataset : resources.focus.experiment;
  const matchesSelection = Boolean(selected?.resource && focused && resourceIdentity(selected.resource) === resourceIdentity(focused)
    && selected.resource.revision === focused.revision);
  async function choose(raw: string) { try { setError(null); await context.select(JSON.parse(raw)); } catch (cause) { setError(String(cause)); } }
  return <div className="chat-experiment-tool">
    <header className="chat-experiment-tool-header"><ChatContextPicker context={context} /></header>
    {error ? <ErrorToast error={error} /> : null}
    {selected?.model || training ? <section className="chat-experiment-tool-content">
      <DropdownSelect floating label="Training run" value={training ? JSON.stringify(selected!.target) : ""} disabled={context.runs.isPending}
        options={[{ value: "", label: context.runs.isPending ? "Loading training runs…" : "Select training run", disabled: true },
          ...(context.runs.data?.runs ?? []).map(run => ({ value: JSON.stringify(run.target), label: run.label, description: run.detail }))]}
        onChange={raw => void choose(raw)} />
      {context.runs.error ? <ErrorToast error={context.runs.error.message} /> : null}
      {context.runs.data && !context.runs.data.runs.length ? <p>No training runs in this account for this model.</p> : null}
    </section> : null}
    {training ? <section className="chat-experiment-tool-content">
      {training.location === "cloud" ? <ModelTrainingJourney compact connection={connection} teamId={training.owner.teamId}
        projectId={training.job.modelProjectId} jobId={training.jobId} onOpenRun={() => window.location.assign(modelsPath(modelsLocation("runs", null, { area: "console", resourceId: `hosted-run:${training.jobId}` })))} /> : <LocalTrainingOverview connection={connection} training={training} />}
    </section> : selected?.resource && sessionId && !matchesSelection ? <p className="chat-experiment-tool-content" role="status">{resources.error ?? "Loading selected context…"}</p>
      : selected?.resource && sessionId ? <DatasetWorkspace connection={connection} sessionId={sessionId} resources={resources} events={events} />
      : selected?.resource ? <section className="chat-experiment-tool-content"><h3>{selected.label}</h3><p>{selected.detail}</p><p>Your next message will use this selection.</p></section>
      : !selected?.model ? <p className="chat-experiment-tool-content">Choose a dataset, experiment, or model to inspect it here and use it in chat.</p> : null}
  </div>;
}
