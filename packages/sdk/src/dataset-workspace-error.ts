import { z } from "zod";
import { readBoundedJsonResponse } from "./protocol.js";

const Code = z.enum([
  "dataset_validation_failed",
  "dataset_grader_invalid",
  "dataset_grader_source_unavailable",
  "dataset_feedback_key_conflict",
  "dataset_request_invalid",
  "dataset_request_failed",
  "dataset_not_found",
  "dataset_revision_conflict",
  "dataset_operation_conflict",
  "dataset_workspace_changed",
  "dataset_validation_changed",
  "dataset_source_context_immutable",
]);
export type DatasetWorkspaceErrorCode = z.infer<typeof Code>;

const Failure = z.object({
  code: Code,
  // Bound the expected wire field, but never retain or display its contents.
  message: z.string().max(5_000).optional(),
}).strict();
const validationGuidance: Partial<Record<DatasetWorkspaceErrorCode, string>> = {
  dataset_validation_failed:
    "Dataset validation failed. Review source privacy and licensing checks, required approved demonstrations, and attached graders before validating the saved revision again.",
  dataset_grader_invalid:
    "Dataset grader validation failed. Review the attached graders and their checked fixtures before validating again.",
  dataset_grader_source_unavailable:
    "An attached grader release is unavailable or has changed. Select the intended published grader release before validating again.",
  dataset_feedback_key_conflict:
    "Attached graders use conflicting feedback keys. Choose distinct published grader feedback keys before validating again.",
};

/** Safe Dataset failure identity. Server messages, bodies and causes are never
 * attached; consumers can map these bounded fields to their own recovery UI. */
export class DatasetWorkspaceRequestError extends Error {
  readonly code: DatasetWorkspaceErrorCode;
  readonly retryable: boolean;
  readonly outcomeUnknown: boolean;
  constructor(readonly status: number, code: DatasetWorkspaceErrorCode = "dataset_request_failed") {
    const safeCode = Code.safeParse(code);
    const value = safeCode.success ? safeCode.data : "dataset_request_failed";
    super((status === 422 ? validationGuidance[value] : undefined) ?? `Dataset request failed (${status}).`);
    this.name = "DatasetWorkspaceRequestError";
    this.code = value;
    this.retryable = status === 408 || status === 429 || status >= 500;
    // A server/timeout failure can follow a committed write. This does not
    // authorize a new operation: recover or retry the original identity.
    this.outcomeUnknown = status === 408 || status >= 500;
  }
}

export async function readDatasetWorkspaceFailure(response: Response): Promise<DatasetWorkspaceRequestError> {
  let code: DatasetWorkspaceErrorCode = "dataset_request_failed";
  try {
    const mediaType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (mediaType === "application/json") {
      const parsed = Failure.safeParse(await readBoundedJsonResponse(response, 16 * 1024, "Dataset failure"));
      if (parsed.success) code = parsed.data.code;
    } else {
      await response.body?.cancel();
    }
  } catch {
    // Invalid, oversized and interrupted failures still retain HTTP status;
    // never expose response text or parser/transport diagnostics.
  }
  return new DatasetWorkspaceRequestError(response.status, code);
}
