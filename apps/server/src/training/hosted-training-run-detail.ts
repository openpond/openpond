import { z } from "zod";
import {
  TrainingJobSchema,
  TrainingJobEventSchema,
  TrainingJobOutputsSchema,
} from "openpond-sdk/training";
import { PostTrainingSummarySchema, PostTrainingControlSchema } from "openpond-sdk/post-training";
import { hostedApiAuthHeaders } from "../openpond/hosted-api-access.js";

const Id = z.string().trim().min(1).max(200);
export const HostedTrainingRunDetailSchema = z
  .object({
    job: TrainingJobSchema,
    events: z.array(TrainingJobEventSchema).max(10_000),
    outputs: TrainingJobOutputsSchema,
    evals: PostTrainingSummarySchema.nullable(),
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
  async function request(path: string, init?: RequestInit) {
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
        if (bytes > 4_194_304) throw new Error("Training evidence exceeded its bounded response.");
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
  return {
    async read(id: string) {
      const base = path(id);
      const [job, events, outputs, evals] = await Promise.all([
        request(base),
        request(`${base}/events`),
        request(`${base}/outputs`),
        request(`${base}/post-training`),
      ]);
      const detail = HostedTrainingRunDetailSchema.parse({
        job: job.job,
        events: events.events,
        outputs,
        evals,
      });
      if (
        detail.job.id !== id ||
        detail.job.teamId !== input.teamId ||
        detail.events.some((event) => event.jobId !== id) ||
        (detail.evals && (detail.evals.teamId !== input.teamId || detail.evals.jobId !== id))
      )
        throw new Error("Training evidence belongs to another run.");
      return detail;
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
