import { CreateHostedSavedWorkRequestSchema } from "@openpond/contracts";
import {
  createHostedSavedWork,
  deleteHostedSavedWork,
  listHostedSavedWork,
  runHostedSavedWork,
  updateHostedSavedWork,
} from "./saved-work.js";

export const hostedSavedWorkRoutePayloads = {
  listHostedSavedWorkPayload: () => listHostedSavedWork(),
  createHostedSavedWorkPayload: (payload: unknown) =>
    createHostedSavedWork(CreateHostedSavedWorkRequestSchema.parse(payload)),
  updateHostedSavedWorkPayload: (scheduleId: string, payload: unknown) =>
    updateHostedSavedWork(scheduleId, payload),
  deleteHostedSavedWorkPayload: (scheduleId: string) =>
    deleteHostedSavedWork(scheduleId),
  runHostedSavedWorkPayload: (scheduleId: string, clientRequestId: string) => {
    if (!clientRequestId.trim()) {
      throw new Error("clientRequestId is required to run scheduled Work.");
    }
    return runHostedSavedWork(scheduleId, clientRequestId);
  },
};
