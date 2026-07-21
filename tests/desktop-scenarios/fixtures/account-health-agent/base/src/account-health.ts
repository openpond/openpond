import { mkdir, writeFile } from "node:fs/promises";

import type { AgentChatInput, AgentChatResult, AgentContext } from "openpond-agent-sdk";

import {
  accountIds,
  accounts,
  approvedSourceContext,
  fixtureAsOfDate,
  requiredAccountSummaries,
  sourceFiles,
  type AccountId,
} from "./fixtures.js";

export const weeklyArtifactRefs = [
  "artifacts/weekly-account-review.md",
  "artifacts/weekly-account-review.csv",
  "artifacts/weekly-account-review.json",
] as const;

type ActionInput = AgentChatInput & Record<string, unknown>;

type WeeklyReviewRow = {
  accountId: AccountId;
  account: string;
  classification: "high risk" | "medium risk" | "expansion opportunity";
  renewalDays: number;
  owner: string;
  nextStep: string;
  sources: string[];
};

const weeklyRows: WeeklyReviewRow[] = [
  {
    accountId: "acme",
    account: "Acme",
    classification: "high risk",
    renewalDays: 21,
    owner: "Revenue Operations with Support",
    nextStep: "Resolve the disputed invoice and open P1 support case before addressing adoption decline.",
    sources: [...sourceFiles],
  },
  {
    accountId: "glacier",
    account: "Glacier",
    classification: "medium risk",
    renewalDays: 43,
    owner: "Unassigned; Customer Success leadership must assign one",
    nextStep: "Assign an account owner before the weekly review and monitor flat usage.",
    sources: ["accounts.json", "product-usage.csv", "support-cases.json"],
  },
  {
    accountId: "northstar",
    account: "Northstar",
    classification: "expansion opportunity",
    renewalDays: 87,
    owner: "Account Executive",
    nextStep: "Follow up on the request for 25 additional seats.",
    sources: ["accounts.json", "product-usage.csv", "billing-status.json"],
  },
];

export async function answerAccountHealthChat(
  ctx: AgentContext,
  input: ActionInput,
): Promise<AgentChatResult> {
  const prompt = String(input.prompt ?? "").trim();
  const accountId = normalizeAccountId(input);

  if (accountId) {
    return accountResult(ctx, accountId, "account-health-chat");
  }

  if (isPriorityFollowUp(prompt)) {
    ctx.trace.event("account-health.priority-follow-up", {
      accountId: "acme",
      priority: "billing-and-p1-first",
    });
    return {
      text: requiredAccountSummaries.acme,
      intent: "account-health-chat",
      metadata: sourceMetadata("acme"),
    };
  }

  return {
    text:
      "Ask about Acme, Northstar, or Glacier, or run Build Weekly Account Review. Responses use only accounts.json, product-usage.csv, support-cases.json, and billing-status.json.",
    intent: "account-health-chat",
    needsUserInput: true,
    metadata: {
      knownAccountIds: accountIds,
      approvedObjective: approvedSourceContext.objective,
      sources: sourceFiles,
    },
  };
}

export async function summarizeAccount(
  ctx: AgentContext,
  input: ActionInput,
): Promise<AgentChatResult> {
  const accountId = requireAccountId(input);
  return accountResult(ctx, accountId, "summarize-account");
}

export async function triageRenewalRisk(
  ctx: AgentContext,
  input: ActionInput,
): Promise<AgentChatResult> {
  const accountId = requireAccountId(input);
  const asOfDate = normalizeStringInput(input, "asOfDate") ?? fixtureAsOfDate;
  ctx.trace.event("account-health.renewal-risk-triaged", {
    accountId,
    asOfDate,
    priority: accountId === "acme" ? "billing-and-p1-first" : "standard",
  });
  return {
    text: requiredAccountSummaries[accountId],
    intent: "triage-renewal-risk",
    metadata: {
      ...sourceMetadata(accountId),
      asOfDate,
      priorityDecision: approvedSourceContext.priorityDecision,
    },
  };
}

export async function buildWeeklyAccountReview(
  ctx: AgentContext,
  input: ActionInput,
): Promise<AgentChatResult> {
  const asOfDate = normalizeStringInput(input, "asOfDate") ?? fixtureAsOfDate;
  const minimumRisk = normalizeStringInput(input, "minimumRisk") ?? "medium";
  const review = {
    schema: "openpond.account-health.weekly-review.v1",
    asOfDate,
    minimumRisk,
    priorityPolicy: approvedSourceContext.priorityDecision,
    accounts: weeklyRows,
    sourceFiles,
  };

  const markdown = renderWeeklyMarkdown(asOfDate, minimumRisk);
  const csv = renderWeeklyCsv();
  const json = `${JSON.stringify(review, null, 2)}\n`;

  await ctx.step("write-weekly-account-review-artifacts", async () => {
    await mkdir("artifacts", { recursive: true });
    await Promise.all([
      writeFile(weeklyArtifactRefs[0], markdown, "utf8"),
      writeFile(weeklyArtifactRefs[1], csv, "utf8"),
      writeFile(weeklyArtifactRefs[2], json, "utf8"),
    ]);
  });

  for (const artifactRef of weeklyArtifactRefs) {
    ctx.trace.artifact(artifactRef, {
      action: "build-weekly-account-review",
      asOfDate,
      sourceFiles,
    });
  }
  ctx.trace.event("account-health.weekly-review-built", {
    accountIds,
    artifactRefs: weeklyArtifactRefs,
  });

  return {
    text:
      `Weekly account review for ${asOfDate} includes Acme (high risk), Glacier (medium risk), and Northstar (expansion opportunity), with explicit owners and next steps. Artifacts: ${weeklyArtifactRefs.join(", ")}.`,
    intent: "build-weekly-account-review",
    artifactRefs: [...weeklyArtifactRefs],
    metadata: {
      asOfDate,
      minimumRisk,
      accountIds,
      approvedObjective: approvedSourceContext.objective,
      sources: sourceFiles,
    },
  };
}

function accountResult(
  ctx: AgentContext,
  accountId: AccountId,
  intent: "account-health-chat" | "summarize-account",
): AgentChatResult {
  ctx.trace.event("account-health.account-summarized", {
    accountId,
    sourceFiles: sourcesForAccount(accountId),
  });
  return {
    text: requiredAccountSummaries[accountId],
    intent,
    metadata: sourceMetadata(accountId),
  };
}

function requireAccountId(input: ActionInput): AccountId {
  const accountId = normalizeAccountId(input);
  if (!accountId) {
    throw new Error("accountId must identify Acme, Northstar, or Glacier.");
  }
  return accountId;
}

export function normalizeAccountId(input: Record<string, unknown>): AccountId | null {
  const direct = normalizeAccountIdValue(input.accountId);
  if (direct) return direct;

  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt) return null;
  const parsed = parsePromptObject(prompt);
  const fromJson = normalizeAccountIdValue(parsed?.accountId);
  if (fromJson) return fromJson;

  const normalizedPrompt = prompt.toLowerCase();
  return accountIds.find((accountId) => {
    const name = accounts[accountId].name.toLowerCase();
    return new RegExp(`\\b(?:${accountId}|${name})\\b`, "i").test(normalizedPrompt);
  }) ?? null;
}

function normalizeStringInput(input: Record<string, unknown>, key: string): string | null {
  const direct = input[key];
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  const parsed = parsePromptObject(prompt);
  const fromJson = parsed?.[key];
  return typeof fromJson === "string" && fromJson.trim() ? fromJson.trim() : null;
}

function normalizeAccountIdValue(value: unknown): AccountId | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  return accountIds.find((accountId) => accountId === normalized) ?? null;
}

function parsePromptObject(prompt: string): Record<string, unknown> | null {
  if (!prompt.startsWith("{") || !prompt.endsWith("}")) return null;
  try {
    const parsed: unknown = JSON.parse(prompt);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function isPriorityFollowUp(prompt: string): boolean {
  return /what should (?:we|i) do first|what comes first|prioriti[sz]e|rank(?:ed|ing)? .*before/i.test(prompt);
}

function sourceMetadata(accountId: AccountId) {
  return {
    accountId,
    approvedObjective: approvedSourceContext.objective,
    sources: sourcesForAccount(accountId),
    evidenceSnapshotId: approvedSourceContext.evidenceSnapshotId,
  };
}

function sourcesForAccount(accountId: AccountId): string[] {
  if (accountId === "acme") return [...sourceFiles];
  if (accountId === "northstar") {
    return ["accounts.json", "product-usage.csv", "billing-status.json"];
  }
  return ["accounts.json", "product-usage.csv", "support-cases.json"];
}

function renderWeeklyMarkdown(asOfDate: string, minimumRisk: string): string {
  const sections = weeklyRows.map((row) => [
    `## ${row.account}`,
    "",
    `- Classification: ${row.classification}`,
    `- Renewal: ${row.renewalDays} days`,
    `- Owner: ${row.owner}`,
    `- Next step: ${row.nextStep}`,
    `- Sources: ${row.sources.join(", ")}`,
  ].join("\n"));
  return [
    "# Weekly account review",
    "",
    `As of: ${asOfDate}`,
    `Minimum risk requested: ${minimumRisk}`,
    "Priority policy: disputed or overdue billing and open P1 support blockers come before adoption decline.",
    "",
    ...sections.flatMap((section) => [section, ""]),
  ].join("\n");
}

function renderWeeklyCsv(): string {
  const header = "accountId,account,classification,renewalDays,owner,nextStep,sources";
  const rows = weeklyRows.map((row) => [
    row.accountId,
    row.account,
    row.classification,
    String(row.renewalDays),
    row.owner,
    row.nextStep,
    row.sources.join("; "),
  ].map(csvCell).join(","));
  return `${[header, ...rows].join("\n")}\n`;
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
