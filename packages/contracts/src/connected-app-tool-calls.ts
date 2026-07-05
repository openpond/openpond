import { z } from "zod";
import {
  CONNECTED_APP_PROVIDER_TOOL_NAMES,
  CONNECTED_APP_TOOL_CALL_ENDPOINT,
  validateConnectedAppToolCallRequest,
  type ConnectedAppToolCallRequest,
} from "@openpond/connected-apps";

const ConnectedAppToolCallProviderSchema = z.enum([
  "slack",
  "microsoft_teams",
  "github",
  "google",
  "x",
  "mcp",
]);

export const ConnectedAppProviderToolOperationSchema = z.enum([
  "search",
  "read",
  "write",
]);

export const ConnectedAppProviderToolNameSchema = z.enum(CONNECTED_APP_PROVIDER_TOOL_NAMES);

export const ConnectedAppToolCallRequestSchema = z
  .object({
    provider: ConnectedAppToolCallProviderSchema,
    operation: ConnectedAppProviderToolOperationSchema,
    toolName: ConnectedAppProviderToolNameSchema,
    sessionId: z.string().trim().min(1).max(200),
    turnId: z.string().trim().min(1).max(200),
    userPrompt: z.string().max(200_000),
    connectionIds: z.array(z.string().trim().min(1).max(300)).min(1).max(8),
    capabilityIds: z.array(z.string().trim().min(1).max(200)).min(1).max(64),
    args: z.record(z.string(), z.unknown()).default({}),
  })
  .strict()
  .superRefine((request, context) => {
    const validation = validateConnectedAppToolCallRequest(request as ConnectedAppToolCallRequest);
    if (!validation.ok) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: validation.error,
      });
    }
  });

export const ConnectedAppToolCallResponseSchema = z
  .object({
    ok: z.boolean(),
    output: z.string().nullable().optional(),
    data: z.unknown().optional(),
  })
  .strict();

export type ConnectedAppProviderToolOperationValue = z.infer<
  typeof ConnectedAppProviderToolOperationSchema
>;
export type ConnectedAppProviderToolNameValue = z.infer<
  typeof ConnectedAppProviderToolNameSchema
>;
export type ConnectedAppToolCallValidatedRequest = z.infer<
  typeof ConnectedAppToolCallRequestSchema
>;
export type ConnectedAppToolCallValidatedResponse = z.infer<
  typeof ConnectedAppToolCallResponseSchema
>;

export { CONNECTED_APP_TOOL_CALL_ENDPOINT };
