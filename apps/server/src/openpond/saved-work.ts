import {
  CreateHostedSavedWorkRequestSchema,
  HostedSavedWorkResponseSchema,
  UpdateHostedSavedWorkRequestSchema,
  type CreateHostedSavedWorkRequest,
} from "@openpond/contracts";
import { requestOpenPondPublicApi } from "./sandboxes.js";

export async function listHostedSavedWork(): Promise<unknown> {
  const payload = HostedSavedWorkResponseSchema.parse(
    await requestOpenPondPublicApi({ path: "/saved-work" })
  );
  return {
    ...payload,
    webBaseUrl: hostedWebBaseUrl(),
  };
}

export async function createHostedSavedWork(
  input: CreateHostedSavedWorkRequest
): Promise<Record<string, unknown>> {
  const body = CreateHostedSavedWorkRequestSchema.parse(input);
  return requestOpenPondPublicApi({
    path: "/saved-work",
    method: "POST",
    body,
  });
}

export async function updateHostedSavedWork(
  scheduleId: string,
  input: unknown
): Promise<Record<string, unknown>> {
  const body = UpdateHostedSavedWorkRequestSchema.parse(input);
  return requestOpenPondPublicApi({
    path: `/saved-work/schedules/${encodeURIComponent(scheduleId)}`,
    method: "PATCH",
    body,
  });
}

export async function deleteHostedSavedWork(
  scheduleId: string
): Promise<Record<string, unknown>> {
  return requestOpenPondPublicApi({
    path: `/saved-work/schedules/${encodeURIComponent(scheduleId)}`,
    method: "DELETE",
  });
}

export async function runHostedSavedWork(
  scheduleId: string,
  clientRequestId: string
): Promise<Record<string, unknown>> {
  return requestOpenPondPublicApi({
    path: `/saved-work/schedules/${encodeURIComponent(scheduleId)}/run`,
    method: "POST",
    body: { clientRequestId },
  });
}

export function hostedWebBaseUrl(
  env: NodeJS.ProcessEnv = process.env
): string {
  const configured =
    env.OPENPOND_HOSTED_WEB_URL?.trim() ||
    env.OPENPOND_SANDBOX_BASE_URL?.trim() ||
    env.OPENPOND_API_URL?.trim() ||
    env.OPENPOND_SANDBOX_API_URL?.trim() ||
    "https://api.openpond.ai";
  const url = new URL(configured);
  if (
    url.hostname === "api.openpond.ai" ||
    url.hostname.endsWith(".api.openpond.ai")
  ) {
    return "https://openpond.ai";
  }
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.origin;
}
