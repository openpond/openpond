import {
  ApprovalSchema,
  DEFAULT_OPENPOND_COMMAND_ACCESS_MODE,
  OpenPondCommandAccessModeSchema,
  type Approval,
  type BootstrapPayload,
  type OpenPondCommandAccessMode,
  type ResolveApprovalRequest,
  type RuntimeEvent,
} from "@openpond/contracts";
import type { SlashCommandDefinition } from "./ui/commands.js";

export type TerminalPermissionChoice = "yes" | "session" | "no" | "skip";

export const TERMINAL_PERMISSION_QUESTION_CHOICES: SlashCommandDefinition[] = [
  { name: "yes", usage: "yes", description: "approve this command", submitText: "yes" },
  { name: "session", usage: "session", description: "approve this command family", submitText: "session" },
  { name: "no", usage: "no", description: "deny this command", submitText: "no" },
  { name: "skip", usage: "skip", description: "cancel this command request", submitText: "skip" },
];

export function parseTerminalPermissionChoice(value: string | null | undefined): TerminalPermissionChoice | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "yes" || normalized === "y" || normalized === "approve") return "yes";
  if (normalized === "session" || normalized === "s") return "session";
  if (normalized === "no" || normalized === "n" || normalized === "deny") return "no";
  if (normalized === "skip" || normalized === "cancel") return "skip";
  return null;
}

export function terminalPermissionDecision(
  choice: TerminalPermissionChoice,
): ResolveApprovalRequest["decision"] {
  if (choice === "yes") return "accept";
  if (choice === "session") return "acceptForSession";
  if (choice === "skip") return "cancel";
  return "decline";
}

export function parseTerminalPermissionMode(
  value: string | null | undefined,
): OpenPondCommandAccessMode | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "full" || normalized === "full-access" || normalized === "full_access") {
    return "full-access";
  }
  const parsed = OpenPondCommandAccessModeSchema.safeParse(normalized);
  return parsed.success ? parsed.data : null;
}

export function formatTerminalPermissionMode(mode: OpenPondCommandAccessMode | null | undefined): string {
  if (mode === "full-access") return "Full access";
  if (mode === "disabled") return "Disabled";
  return "Ask";
}

export function latestPendingCommandApproval(
  payload: BootstrapPayload | null,
  sessionId: string | null,
): Approval | null {
  if (!payload || !sessionId) return null;
  return (
    (payload.approvals ?? [])
      .filter((approval) =>
        approval.kind === "command" &&
        approval.status === "pending" &&
        approval.sessionId === sessionId
      )
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0] ?? null
  );
}

export function commandApprovalFromRuntimeEvent(event: RuntimeEvent): Approval | null {
  if (event.name !== "approval.requested") return null;
  const parsed = ApprovalSchema.safeParse(event.data);
  if (!parsed.success || parsed.data.kind !== "command" || parsed.data.status !== "pending") return null;
  return parsed.data;
}

export function commandApprovalIdFromResolvedEvent(event: RuntimeEvent): string | null {
  if (event.name !== "approval.resolved") return null;
  const data = event.data && typeof event.data === "object" && !Array.isArray(event.data)
    ? event.data as Record<string, unknown>
    : null;
  const value = data?.approvalId ?? data?.approval_id ?? data?.id;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function commandAccessModeForSession(
  payload: BootstrapPayload | null,
  sessionId: string | null,
): OpenPondCommandAccessMode {
  const session = payload?.sessions.find((candidate) => candidate.id === sessionId)
    ?? payload?.codexHistorySessions?.find((candidate) => candidate.id === sessionId)
    ?? null;
  return (
    session?.openPondCommandAccessMode ??
    payload?.preferences?.openPondCommandAccessMode ??
    DEFAULT_OPENPOND_COMMAND_ACCESS_MODE
  );
}

export function formatTerminalPermissionsSummary(
  mode: OpenPondCommandAccessMode,
): string {
  return [
    `Command access: ${formatTerminalPermissionMode(mode)}`,
    "Use /permissions ask or /permissions full-access to update this chat.",
    "When a command approval is pending, /permissions opens yes/session/no/skip choices.",
  ].join("\n");
}

export function formatTerminalCommandApprovalQuestion(approval: Approval): string {
  const detail = commandApprovalDetail(approval);
  const rows = [
    "Command approval",
    `command: ${detail.command ?? approval.title}`,
    detail.cwd ? `cwd: ${detail.cwd}` : null,
    detail.risk ? `risk: ${detail.risk}` : null,
    detail.timeoutSeconds ? `timeout: ${detail.timeoutSeconds}s` : null,
    detail.familyLabel ? `session approval family: ${detail.familyLabel}` : null,
    "Choose: yes, session, no, or skip.",
  ];
  return rows.filter(Boolean).join("\n");
}

function commandApprovalDetail(approval: Approval): {
  command: string | null;
  cwd: string | null;
  risk: string | null;
  timeoutSeconds: number | null;
  familyLabel: string | null;
} {
  try {
    const parsed = JSON.parse(approval.detail) as Record<string, unknown>;
    const family = parsed.sessionApprovalFamily &&
      typeof parsed.sessionApprovalFamily === "object" &&
      !Array.isArray(parsed.sessionApprovalFamily)
      ? parsed.sessionApprovalFamily as Record<string, unknown>
      : null;
    return {
      command: stringValue(parsed.command),
      cwd: stringValue(parsed.cwd),
      risk: stringValue(parsed.risk),
      timeoutSeconds: typeof parsed.timeoutSeconds === "number" ? parsed.timeoutSeconds : null,
      familyLabel: stringValue(family?.label),
    };
  } catch {
    return {
      command: null,
      cwd: null,
      risk: null,
      timeoutSeconds: null,
      familyLabel: null,
    };
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
