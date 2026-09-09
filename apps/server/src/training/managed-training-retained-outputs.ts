import type { ModelProject } from "@openpond/contracts";
import { createTrainingClient, parseAndVerifyTrainingExecutionReceipt } from "openpond-sdk/training";

import { hostedApiAuthHeaders } from "../openpond/hosted-api-access.js";

export interface ManagedTrainingOutputAccess {
  apiBaseUrl: string;
  token: string;
  teamId: string;
}

/** Resolve bytes by retained public receipts while preserving workspace and Job identity. */
export async function readManagedTrainingRetainedOutputs(input: {
  project: ModelProject;
  jobId: string;
  access: ManagedTrainingOutputAccess;
  expectedSubmissionHash?: string;
  expectedManifestHash?: string;
  fetch?: typeof fetch;
}) {
  const { project, access } = input;
  if (!project.hosted?.apiOrigin || project.hosted.teamId !== access.teamId
    || new URL(project.hosted.apiOrigin).origin !== new URL(access.apiBaseUrl).origin) {
    throw new Error("The trained artifact does not belong to the active workspace and API origin.");
  }
  const headers = hostedApiAuthHeaders(access.token);
  headers.set("x-openpond-team-id", access.teamId);
  const client = createTrainingClient({ baseUrl: access.apiBaseUrl, headers, fetch: input.fetch });
  const [job, outputs] = await Promise.all([client.getJob(input.jobId), client.outputs(input.jobId)]);
  if (job.id !== input.jobId || job.teamId !== access.teamId || job.modelProjectId !== project.hosted.projectId
    || job.portableProjectId !== project.id || job.state !== "succeeded"
    || (input.expectedSubmissionHash && job.submissionHash !== input.expectedSubmissionHash)) {
    throw new Error("The retained training outputs differ from the completed Model run.");
  }
  const receiptOutputs = outputs.outputs.filter(output => output.kind === "receipt" && output.jobId === job.id);
  if (!outputs.receipt || receiptOutputs.length !== 1) throw new Error("The completed Model run must retain one execution receipt.");
  const receipt = await parseAndVerifyTrainingExecutionReceipt(outputs.receipt, {
    id: outputs.receipt.id, contentHash: receiptOutputs[0]!.contentHash,
    teamId: access.teamId, jobId: job.id, requireCleanup: true,
  });
  if (receipt.submissionHash !== job.submissionHash
    || (input.expectedManifestHash && receipt.manifestHash !== input.expectedManifestHash)
    || outputs.outputs.some(output => output.jobId !== job.id || (output.kind !== "receipt"
      && !receipt.outputs.some(reference => reference.id === output.id && reference.contentHash === output.contentHash)))) {
    throw new Error("The execution receipt does not bind the exact training outputs and inputs.");
  }
  const adapters = outputs.outputs.filter(output => output.kind === "adapter");
  if (adapters.length > 1) throw new Error("The completed Model run returned multiple candidate adapters.");
  return { job, outputs, receipt, adapter: adapters[0] ?? null };
}
