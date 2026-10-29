import { z } from "zod";

const WorkerControlSchema = z.object({
  workerId: z.string().min(1).max(191),
  expectedControlRevision: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: z.string().min(1).max(191),
  jobId: z.string().min(1).max(191).optional(),
  maximumStorageUsd: z.number().positive().max(10).optional(),
  warmIdleDeadlineAt: z.iso.datetime({ offset: true }).optional(),
  maximumIdleUsd: z.number().positive().max(10).optional(),
  sessionId: z.string().min(1).max(191).optional(),
  sessionDeadlineAt: z.iso.datetime({ offset: true }).optional(),
  maximumSessionUsd: z.number().positive().max(30).optional(),
  idleGraceSeconds: z.number().int().min(120).max(28800).optional(),
  preservePhysicalUntilDeadline: z.boolean().optional(),
}).strict().refine(control => control.preservePhysicalUntilDeadline === true ||
  control.idleGraceSeconds === undefined || control.idleGraceSeconds <= 10800, {
  path: ["idleGraceSeconds"], message: "Ordinary session idle grace cannot exceed three hours.",
});

/** Uses the hosted command's existing account headers and bounded transport. */
export async function runHostedWorkerCommand(input: {
  action: string;
  target: string | undefined;
  baseUrl: string;
  headers: Headers;
  request: typeof fetch;
  readInput(): Promise<unknown>;
  confirmed: boolean;
}): Promise<unknown> {
  let path = "/v1/managed-rl/physical-workers";
  let body: string | undefined;
  if (input.action === "hosted-workers") {
    if (input.target) throw new Error("hosted-workers does not accept an identifier.");
  } else if (input.action === "hosted-worker-adopt") {
    if (!input.confirmed) throw new Error("Attaching a reserved GPU requires --yes and a funded queued job.");
    body = JSON.stringify(z.object({
      jobId: z.string().min(1).max(191), providerPodId: z.string().min(1).max(191),
      idempotencyKey: z.string().min(1).max(191), deadlineAt: z.iso.datetime({ offset: true }),
      maximumHourlyUsd: z.number().positive().max(10), maximumSessionUsd: z.number().positive().max(30),
    }).strict().parse(await input.readInput()));
    path += "/adopt";
  } else if (input.action === "hosted-worker-enroll" || input.action === "hosted-worker-verify") {
    if (!input.confirmed || !input.target) throw new Error("Reserved GPU enrollment requires a worker ID and --yes.");
    path += `/${encodeURIComponent(input.target)}/${input.action === "hosted-worker-enroll" ? "enroll" : "enrollment-verification"}`;
    body = "{}";
  } else if (input.action === "hosted-worker") {
    if (!input.target) throw new Error("hosted-worker requires a physical worker ID.");
    path += `/${encodeURIComponent(input.target)}`;
  } else {
    const action = input.action.replace("hosted-worker-", "");
    if (!["stop", "resume", "retire", "warm-idle", "retain-session"].includes(action)) throw new Error(`Unknown physical worker action: ${action}`);
    if (!input.confirmed) throw new Error("Worker lifecycle changes require --yes.");
    const { workerId, ...control } = WorkerControlSchema.parse(await input.readInput());
    if (control.preservePhysicalUntilDeadline !== undefined && action !== "retain-session")
      throw new Error("Physical preservation is available only on retain-session with a fixed deadline and budget.");
    if (action === "stop" && !control.maximumStorageUsd) throw new Error("Stopping requires maximumStorageUsd for bounded retained storage.");
    if (action === "resume" && !control.jobId) throw new Error("Resuming requires an admitted queued jobId with its own compute budget.");
    if (action === "warm-idle" && (!control.warmIdleDeadlineAt || !control.maximumIdleUsd))
      throw new Error("Warm idle requires warmIdleDeadlineAt and maximumIdleUsd; the server caps retention at three hours.");
    if (action === "retain-session" && (!control.sessionId || !control.sessionDeadlineAt || !control.maximumSessionUsd || !control.idleGraceSeconds))
      throw new Error("Session retention requires sessionId, sessionDeadlineAt, maximumSessionUsd, and idleGraceSeconds; its deadline and active-plus-idle execution budget cannot be renewed; reserve cleanup costs separately.");
    path += `/${encodeURIComponent(workerId)}/control`;
    body = JSON.stringify({ ...control, action });
  }
  const headers = new Headers(input.headers);
  headers.set("accept", "application/json");
  if (body) headers.set("content-type", "application/json");
  const response = await input.request(new URL(path, input.baseUrl), { method: body ? "POST" : "GET", headers, body });
  const value: unknown = await response.json();
  if (!response.ok) {
    const code = value && typeof value === "object" && "error" in value && typeof value.error === "string" ? value.error : "worker_request_failed";
    throw new Error(`Physical worker request failed (${response.status}): ${code}. Read hosted-worker before retrying a lifecycle mutation.`);
  }
  return value;
}
