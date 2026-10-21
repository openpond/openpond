/** Read the same bounded, immutable grader evidence used by run inspectors.
 * Authentication and transport come from the existing hosted CLI context. */
export async function readHostedGraderFeedback(input: {
  jobId: string;
  baseUrl: string;
  headers: Headers;
  request: typeof fetch;
  trajectoryId?: string;
  evaluationId?: string;
  taskId?: string;
}): Promise<unknown> {
  const trajectory = Boolean(input.trajectoryId);
  if (trajectory === Boolean(input.evaluationId) || (trajectory && input.taskId) || (!trajectory && !input.taskId)) {
    throw new Error("hosted-feedback requires either --trajectory-id, or --evaluation-id with --task-id.");
  }
  const kind = trajectory ? "trajectory" : "evaluation";
  const id = (trajectory ? input.trajectoryId : input.evaluationId)!;
  const url = new URL(`/v1/managed-rl/jobs/${encodeURIComponent(input.jobId)}/feedback`, input.baseUrl);
  url.searchParams.set("kind", kind);
  url.searchParams.set("id", id);
  if (input.taskId) url.searchParams.set("taskId", input.taskId);
  const response = await input.request(url, { headers: input.headers });
  if (!response.ok) throw new Error(`Hosted grader feedback read failed (${response.status}).`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 262_144) throw new Error("Hosted grader feedback exceeds its response limit.");
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (value?.jobId !== input.jobId || value.kind !== kind || value.id !== id || (input.taskId && value.taskId !== input.taskId)) {
    throw new Error("Hosted grader feedback does not match the requested execution evidence.");
  }
  return value;
}
