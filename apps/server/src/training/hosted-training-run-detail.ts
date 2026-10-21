import { z } from "zod";
import {
  TrainingJobSchema,
  TrainingJobEventSchema,
  TrainingJobOutputsSchema,
} from "openpond-sdk/training";
import { PostTrainingSummarySchema, PostTrainingControlSchema } from "openpond-sdk/post-training";
import { hostedApiAuthHeaders } from "../openpond/hosted-api-access.js";
import { RunStageEvidenceSchema, RunFeedbackTargetSchema, RunGraderFeedbackSchema } from "@openpond/contracts";
import { hostedRunStageEvidence } from "./hosted-run-stage-evidence.js";

const Id = z.string().trim().min(1).max(200);
export const HostedTrainingRunDetailSchema = z
  .object({
    job: TrainingJobSchema,
    events: z.array(TrainingJobEventSchema).max(10_000),
    outputs: TrainingJobOutputsSchema,
    evals: PostTrainingSummarySchema.nullable(),
    flow: RunStageEvidenceSchema.nullable(),
    flowError: z.string().nullable(),
  })
  .strict();
/** Scope is supplied by the authenticated desktop session, never a URL token.
 * Hosted API job ownership remains authoritative for every read and command. */
export function createHostedTrainingRunDetail(input: {
  teamId: string;
  actorId: string;
  access: { apiBaseUrl: string; token: string };
  currentIdentity: () => Promise<{ teamId: string; actorId: string } | null>;
}) {
  async function fence() {
    const current = await input.currentIdentity();
    if (current?.teamId !== input.teamId || current.actorId !== input.actorId)
      throw new Error("The active account changed. Reload this training run.");
  }
  async function request(path: string, init?: RequestInit, maxBytes = 4_194_304) {
    await fence();
    const headers = hostedApiAuthHeaders(input.access.token);
    headers.set("x-openpond-team-id", input.teamId);
    headers.set("Content-Type", "application/json");
    const response = await fetch(`${input.access.apiBaseUrl.replace(/\/+$/, "")}${path}`, {
      ...init,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`Training run is unavailable (${response.status}).`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Training evidence returned no body.");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes) throw new Error("Training evidence exceeded its bounded response.");
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    await fence();
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  const path = (id: string) => `/v1/training/jobs/${encodeURIComponent(Id.parse(id))}`;
  async function readFlow(id: string) {
    Id.parse(id);
    const raw = await request(`/v1/managed-rl/jobs/${encodeURIComponent(id)}?view=console`, undefined, 67_108_864);
    const projectId = z.string().min(1).parse(raw.job?.job?.modelProjectId);
    const flow = hostedRunStageEvidence(raw.job, { entries: [] }, { jobId: id, teamId: input.teamId, modelProjectId: projectId });
    await fence();
    return flow;
  }
  return {
    readFlow,
    async feedback(id: string, target: unknown) {
      Id.parse(id);
      const reference = RunFeedbackTargetSchema.parse(target);
      const query = new URLSearchParams({ kind: reference.kind, id: reference.id, ...(reference.taskId ? { taskId: reference.taskId } : {}) });
      const result = RunGraderFeedbackSchema.parse(await request(`/v1/managed-rl/jobs/${encodeURIComponent(id)}/feedback?${query}`, undefined, 262144));
      if (result.jobId !== id || result.kind !== reference.kind || result.id !== reference.id || result.taskId !== reference.taskId) throw new Error("Grader feedback belongs to another run or attempt.");
      return result;
    },
    async summary(id: string) {
      const result = await request(path(id));
      const job = TrainingJobSchema.parse(result.job);
      if (job.id !== id || job.teamId !== input.teamId) throw new Error("Training summary belongs to another run.");
      return job;
    },
    async logs(id: string) {
      Id.parse(id);
      const raw = await request(`/v1/managed-rl/jobs/${encodeURIComponent(id)}/logs`);
      const entries = z.object({ entries: z.array(z.object({ id: z.string(), timestamp: z.string(), source: z.string(), message: z.string(), level: z.string() }).passthrough()).max(10000) }).passthrough().parse(raw).entries;
      return RunStageEvidenceSchema.shape.logs.parse(entries.slice(-200).map(entry => ({ id: entry.id, at: entry.timestamp, source: entry.source.replaceAll("_", " "), message: entry.message, level: entry.level })));
    },
    async read(id: string, options: { includeFlow?: boolean } = {}) {
      const base = path(id);
      const [job, events, outputs, evals] = await Promise.all([
        request(base),
        request(`${base}/events`),
        request(`${base}/outputs`),
        request(`${base}/post-training`),
      ]);
      const core = HostedTrainingRunDetailSchema.omit({ flow: true, flowError: true }).parse({
        job: job.job,
        events: events.events,
        outputs,
        evals,
      });
      if (
        core.job.id !== id ||
        core.job.teamId !== input.teamId ||
        core.events.some((event) => event.jobId !== id) ||
        (core.evals && (core.evals.teamId !== input.teamId || core.evals.jobId !== id))
      )
        throw new Error("Training evidence belongs to another run.");
      let flow = null,
        flowError = null;
      if (options.includeFlow !== false) try {
        flow = await readFlow(id);
        if (flow.modelProjectId !== core.job.modelProjectId) throw new Error("Flow evidence belongs to a different Model Project.");
      } catch (error) {
        flowError =
          error instanceof z.ZodError
            ? "The hosted run returned invalid graph evidence."
            : error instanceof Error
              ? error.message
              : "Run graph is unavailable.";
      }
      await fence();
      return HostedTrainingRunDetailSchema.parse({ ...core, flow, flowError });
    },
    async control(id: string, action: "start" | "retry" | "cancel", raw: unknown) {
      const body = PostTrainingControlSchema.parse(raw);
      const value = PostTrainingSummarySchema.parse(
        await request(`${path(id)}/post-training/${action}`, {
          method: "POST",
          body: JSON.stringify(body),
        }),
      );
      if (value.jobId !== id || value.teamId !== input.teamId || value.planHash !== body.planHash)
        throw new Error("The evaluation command returned a different run or plan.");
      return value;
    },
  };
}
