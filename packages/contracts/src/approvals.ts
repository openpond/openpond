import { z } from "zod";

export const ApprovalSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  turnId: z.string().nullable(),
  providerRequestId: z.union([z.string(), z.number()]),
  kind: z.enum([
    "command",
    "file_change",
    "permissions",
    "user_input",
    "create_plan",
    "legacy_exec",
    "legacy_patch",
  ]),
  title: z.string(),
  detail: z.string(),
  status: z.enum(["pending", "accepted", "accepted_for_session", "declined", "cancelled"]),
  createdAt: z.string(),
});

export type Approval = z.infer<typeof ApprovalSchema>;
