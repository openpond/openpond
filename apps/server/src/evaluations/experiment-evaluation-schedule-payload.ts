import { z } from "zod";
import { ExperimentEvaluationScheduleCommandSchema } from "openpond-sdk/experiment-evaluation-schedules";
import type { createExperimentEvaluationScheduleService } from "./experiment-evaluation-schedule-service.js";
/** The native authenticated bridge scopes the whole command, including list
 * pagination; visiting this endpoint never dispatches an occurrence. */
export function createExperimentEvaluationSchedulePayload(deps: {
  service: ReturnType<typeof createExperimentEvaluationScheduleService>;
  identity(): Promise<{ actorId: string; teamId: string }>;
  authorizeProject(id: string): Promise<void>;
}) {
  return async (raw: unknown) => {
    const input = z
        .object({
          teamId: z.string().min(1),
          projectId: z.string().min(1).nullable(),
          request: ExperimentEvaluationScheduleCommandSchema,
        })
        .strict()
        .parse(raw),
      actor = await deps.identity();
    if (actor.teamId !== input.teamId || !actor.actorId)
      throw new Error("Select the signed-in evaluation workspace.");
    const request = input.request;
    const stopping =
      request.operation === "control" &&
      request.request.action !== "retry_active";
    if (input.projectId && !stopping)
      await deps.authorizeProject(input.projectId);
    if (request.operation === "publish") {
      if (
        request.request.teamId !== actor.teamId ||
        request.request.projectId !== input.projectId
      )
        throw new Error("Schedule publication changed its reviewed scope.");
      return deps.service.publish(request.request);
    }
    if (request.operation === "list") {
      const page = await deps.service.list(
        input.teamId,
        request.cursor,
        request.limit,
      );
      return {
        ...page,
        items: page.items.filter((item) => item.projectId === input.projectId),
      };
    }
    const current = await deps.service.read(
      input.teamId,
      request.operation === "read" ? request.id : request.request.id,
    );
    if (current.projectId !== input.projectId)
      throw new Error("The schedule belongs to another Project.");
    if (request.operation === "read") return current;
    if (request.request.teamId !== actor.teamId)
      throw new Error("The schedule control workspace changed.");
    return deps.service.control(request.request);
  };
}
