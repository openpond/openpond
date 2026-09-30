import { EvaluationTime } from "./EvaluationPresentation";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { DatasetWorkspaceVersionsSchema } from "openpond-sdk/dataset-workspaces";
import type { z } from "zod";
import type { WorkspaceApi } from "./workspace-api";
export function DatasetVersions({ api, datasetId, onSelect }: { api: WorkspaceApi; datasetId: string; onSelect: (revision: number | null, publication?: z.infer<typeof DatasetWorkspaceVersionsSchema>["items"][number]["publication"]) => void }) {
  const [beforeRevision, setBefore] = useState<number | undefined>();
  const page = useQuery({ queryKey: ["evaluation-workspace", api.key, "datasetVersions", datasetId, beforeRevision], queryFn: ({ signal }) => api.request<z.infer<typeof DatasetWorkspaceVersionsSchema>>("datasetVersions", { id: datasetId, ...(beforeRevision === undefined ? {} : { beforeRevision }) }, signal) });
  return <section><h2>Published versions</h2><p>Each release keeps its original tasks, grader pins and files. Editing the next version preserves these releases.</p>{page.error ? <p role="alert">{page.error.message}</p> : null}{page.isPending ? <p role="status">Loading versions…</p> : null}<table className="training-data-table evaluation-workspace-table"><thead><tr><th>Release</th><th>Published</th><th>Content hash</th><th /></tr></thead><tbody>{page.data?.items.map(item => <tr key={item.workspaceRevision}><td>Revision {item.publication.release.revision}</td><td><EvaluationTime value={item.publishedAt} /></td><td>{item.publication.release.contentHash}</td><td><button className="training-text-button" onClick={() => onSelect(item.workspaceRevision, item.publication)}>Inspect version</button></td></tr>)}</tbody></table>{page.data?.items.length === 0 ? <p>No published versions yet.</p> : null}{beforeRevision ? <button onClick={() => setBefore(undefined)}>Newest versions</button> : null}{page.data?.nextBeforeRevision ? <button onClick={() => setBefore(page.data!.nextBeforeRevision!)}>Older versions</button> : null}<button className="training-text-button" onClick={() => onSelect(null)}>Current workspace</button></section>;
}
