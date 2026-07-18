import { Buffer } from "node:buffer";
import {
  CROSS_SYSTEM_OPERATIONS_SCHEMA_VERSION,
  CROSS_SYSTEM_TOOL_CONTRACT_HASH,
  type CrossSystemToolName,
} from "@openpond/contracts";
import { z } from "zod";
import { PersistentPythonSandbox } from "./python-sandbox.js";
import type { CrossSystemTask, CrossSystemToolEvidence, CrossSystemWorld } from "./types.js";

const CursorSchema = z.string().trim().min(1).max(256).nullable();
const LimitSchema = z.number().int().min(1).max(50);
const SearchCrmInputSchema = z.object({
  query: z.string().trim().min(1).max(500),
  fields: z.array(z.enum(["account_id", "name", "aliases", "contact_ids", "contract_value_usd_cents", "renewal_date", "tier", "active_contract_id", "contract_term_months"])).min(1).max(12),
  cursor: CursorSchema,
  limit: LimitSchema,
}).strict();
const QueryBillingInputSchema = z.object({
  account_ids: z.array(z.string().trim().min(1).max(100)).min(1).max(50),
  date_range: z.object({ from: z.iso.date(), to: z.iso.date() }).strict(),
  status: z.array(z.enum(["open", "overdue", "paid", "disputed", "scheduled", "void"])).min(1).max(6),
  cursor: CursorSchema,
  limit: LimitSchema,
}).strict();
const SearchSupportInputSchema = z.object({
  account_ids: z.array(z.string().trim().min(1).max(100)).min(1).max(50),
  severity: z.array(z.enum(["P1", "P2", "P3", "P4"])).min(1).max(4),
  state: z.array(z.enum(["new", "investigating", "waiting_customer", "resolved", "closed"])).min(1).max(5),
  cursor: CursorSchema,
  limit: LimitSchema,
}).strict();
const RunPythonInputSchema = z.object({ code: z.string().trim().min(1).max(10_000) }).strict();

export type CrossSystemToolResponse = {
  schemaVersion: "openpond.crossSystemOperations.v1";
  toolContractHash: string;
  items?: unknown[];
  next_cursor?: string | null;
  stdout?: string;
  result?: unknown;
  budget: { turnsRemaining: number; rowsRemaining: number; bytesRemaining: number };
};

export class CrossSystemToolError extends Error {
  constructor(readonly code: "schema_violation" | "budget_exhausted" | "cursor_invalid" | "execution_failed", message: string) {
    super(message);
    this.name = "CrossSystemToolError";
  }
}

export class CrossSystemEnvironment {
  readonly evidence: CrossSystemToolEvidence[] = [];
  private python: PersistentPythonSandbox | null;
  private turns = 0;
  private rows = 0;
  private bytes = 0;
  private closed = false;

  constructor(readonly input: {
    attemptId: string;
    world: CrossSystemWorld;
    task: CrossSystemTask;
    python?: PersistentPythonSandbox;
  }) {
    if (input.world.id !== input.task.worldId) throw new Error("Task and world do not share lineage.");
    if (input.world.toolContractHash !== CROSS_SYSTEM_TOOL_CONTRACT_HASH || input.task.toolContractHash !== CROSS_SYSTEM_TOOL_CONTRACT_HASH) {
      throw new Error("Cross-system tool contract hash mismatch.");
    }
    this.python = input.python ?? null;
  }

  async execute(name: CrossSystemToolName, args: unknown, signal?: AbortSignal): Promise<CrossSystemToolResponse> {
    if (this.closed) throw new CrossSystemToolError("execution_failed", "Cross-system attempt is closed.");
    if (signal?.aborted) throw abortError(signal);
    this.assertTurnBudget();
    const sequence = this.evidence.length;
    const started = performance.now();
    let rows = 0;
    try {
      let payload: Omit<CrossSystemToolResponse, "budget">;
      if (name === "search_crm") {
        const parsed = parse(SearchCrmInputSchema, args);
        const records = searchCrm(this.input.world, parsed.query, parsed.fields);
        const page = this.page(name, records, parsed.cursor, parsed.limit);
        rows = page.items.length;
        payload = { schemaVersion: CROSS_SYSTEM_OPERATIONS_SCHEMA_VERSION, toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH, ...page };
      } else if (name === "query_billing") {
        const parsed = parse(QueryBillingInputSchema, args);
        if (parsed.date_range.from > parsed.date_range.to) throw new CrossSystemToolError("schema_violation", "date_range.from must not be after date_range.to.");
        const records = queryBilling(this.input.world, parsed.account_ids, parsed.date_range, parsed.status);
        const page = this.page(name, records, parsed.cursor, parsed.limit);
        rows = page.items.length;
        payload = { schemaVersion: CROSS_SYSTEM_OPERATIONS_SCHEMA_VERSION, toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH, ...page };
      } else if (name === "search_support") {
        const parsed = parse(SearchSupportInputSchema, args);
        const records = this.input.world.supportCases
          .filter((item) => parsed.account_ids.includes(item.accountId) && parsed.severity.includes(item.severity) && parsed.state.includes(item.state))
          .sort((left, right) => left.caseId.localeCompare(right.caseId))
          .map(supportRecord);
        const page = this.page(name, records, parsed.cursor, parsed.limit);
        rows = page.items.length;
        payload = { schemaVersion: CROSS_SYSTEM_OPERATIONS_SCHEMA_VERSION, toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH, ...page };
      } else {
        const parsed = parse(RunPythonInputSchema, args);
        this.python ??= new PersistentPythonSandbox();
        const result = await this.python.run(parsed.code, signal);
        if (!result.ok) throw new CrossSystemToolError("execution_failed", result.error ?? "Python execution failed.");
        payload = { schemaVersion: CROSS_SYSTEM_OPERATIONS_SCHEMA_VERSION, toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH, stdout: result.stdout, result: result.result };
      }
      const responseBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
      this.consume(rows, responseBytes);
      const response = { ...payload, budget: this.budget() };
      this.record({ sequence, name, args, ok: true, rows, bytes: responseBytes, durationMs: elapsed(started), result: response, error: null });
      return response;
    } catch (error) {
      const normalized = normalizeToolError(error);
      this.record({ sequence, name, args, ok: false, rows, bytes: 0, durationMs: elapsed(started), result: null, error: normalized.message });
      throw normalized;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.python?.close();
    this.python = null;
  }

  private page(name: CrossSystemToolName, items: unknown[], cursor: string | null, limit: number): { items: unknown[]; next_cursor: string | null } {
    const offset = decodeCursor(cursor, name, this.input.world.id);
    const page = items.slice(offset, offset + limit);
    const next = offset + page.length < items.length ? encodeCursor(name, this.input.world.id, offset + page.length) : null;
    return { items: page, next_cursor: next };
  }

  private assertTurnBudget(): void {
    if (this.turns >= this.input.task.budget.maxTurns) throw new CrossSystemToolError("budget_exhausted", "Cross-system 15-turn budget exhausted.");
    this.turns += 1;
  }

  private consume(rows: number, bytes: number): void {
    if (this.rows + rows > this.input.task.budget.maxRows || this.bytes + bytes > this.input.task.budget.maxBytes) {
      throw new CrossSystemToolError("budget_exhausted", "Cross-system row or byte budget exhausted.");
    }
    this.rows += rows;
    this.bytes += bytes;
  }

  private budget() {
    return {
      turnsRemaining: Math.max(0, this.input.task.budget.maxTurns - this.turns),
      rowsRemaining: Math.max(0, this.input.task.budget.maxRows - this.rows),
      bytesRemaining: Math.max(0, this.input.task.budget.maxBytes - this.bytes),
    };
  }

  private record(input: { sequence: number; name: CrossSystemToolName; args: unknown; ok: boolean; rows: number; bytes: number; durationMs: number; result: unknown; error: string | null }): void {
    this.evidence.push({
      schemaVersion: CROSS_SYSTEM_OPERATIONS_SCHEMA_VERSION,
      attemptId: this.input.attemptId,
      sequence: input.sequence,
      toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH,
      tool: input.name,
      arguments: isRecord(input.args) ? input.args : {},
      ok: input.ok,
      rows: input.rows,
      bytes: input.bytes,
      durationMs: input.durationMs,
      result: input.result,
      error: input.error,
    });
  }
}

function searchCrm(world: CrossSystemWorld, query: string, fields: string[]): Record<string, unknown>[] {
  const normalized = query.trim().toLowerCase();
  const matches = world.accounts.filter((account) => {
    if (normalized === "*") return true;
    const searchable = [account.accountId, account.name, ...account.aliases, account.tier, account.renewalDate, account.activeContractId].join(" ").toLowerCase();
    return normalized.split(/\s+/).every((token) => searchable.includes(token));
  });
  return matches.sort((left, right) => left.accountId.localeCompare(right.accountId)).map((account) => {
    const source: Record<string, unknown> = {
      account_id: account.accountId,
      name: account.name,
      aliases: account.aliases,
      contact_ids: account.contactIds,
      contract_value_usd_cents: account.contractValueUsdCents,
      renewal_date: account.renewalDate,
      tier: account.tier,
      active_contract_id: account.activeContractId,
      contract_term_months: account.contractTermMonths,
    };
    return Object.fromEntries(fields.map((field) => [field, source[field]]));
  });
}

function queryBilling(world: CrossSystemWorld, accountIds: string[], range: { from: string; to: string }, statuses: string[]): Record<string, unknown>[] {
  const accountById = new Map(world.accounts.map((item) => [item.accountId, item]));
  const invoices = world.invoices
    .filter((item) => accountIds.includes(item.accountId) && statuses.includes(item.status) && item.issuedDate >= range.from && item.issuedDate <= range.to)
    .map((item) => ({ kind: "invoice", invoice_id: item.invoiceId, account_id: item.accountId, contract_id: item.contractId, issued_date: item.issuedDate, due_date: item.dueDate, currency: item.currency, amount_cents: item.amountCents, status: item.status, descriptor: item.descriptor, billed_term_months: item.billedTermMonths }));
  const payments = statuses.includes("paid")
    ? world.payments
      .filter((item) => item.receivedDate >= range.from && item.receivedDate <= range.to)
      .filter((item) => item.accountId ? accountIds.includes(item.accountId) : accountIds.some((id) => descriptorMatches(item.descriptor, accountById.get(id))))
      .map((item) => ({ kind: "payment", payment_id: item.paymentId, account_id: item.accountId, received_date: item.receivedDate, currency: item.currency, amount_cents: item.amountCents, descriptor: item.descriptor, matched_invoice_id: item.matchedInvoiceId }))
    : [];
  return [...invoices, ...payments].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function supportRecord(item: CrossSystemWorld["supportCases"][number]): Record<string, unknown> {
  return { case_id: item.caseId, account_id: item.accountId, customer_identifier: item.customerIdentifier, severity: item.severity, state: item.state, opened_at: item.openedAt, response_due_at: item.responseDueAt, resolution_due_at: item.resolutionDueAt, first_response_at: item.firstResponseAt, resolved_at: item.resolvedAt, escalation_history: item.escalationHistory };
}

function descriptorMatches(descriptor: string, account: CrossSystemWorld["accounts"][number] | undefined): boolean {
  if (!account) return false;
  const value = normalize(descriptor);
  return [account.name, ...account.aliases].some((candidate) => value.includes(normalize(candidate)));
}

function normalize(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]/g, ""); }

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new CrossSystemToolError("schema_violation", z.prettifyError(result.error));
  return result.data;
}

function encodeCursor(tool: CrossSystemToolName, worldId: string, offset: number): string {
  return Buffer.from(JSON.stringify({ v: 1, tool, worldId, offset }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | null, tool: CrossSystemToolName, worldId: string): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    if (parsed.v !== 1 || parsed.tool !== tool || parsed.worldId !== worldId || !Number.isInteger(parsed.offset) || Number(parsed.offset) < 0) throw new Error();
    return Number(parsed.offset);
  } catch {
    throw new CrossSystemToolError("cursor_invalid", "Cursor does not belong to this tool and world.");
  }
}

function normalizeToolError(error: unknown): CrossSystemToolError {
  return error instanceof CrossSystemToolError ? error : new CrossSystemToolError("execution_failed", error instanceof Error ? error.message : String(error));
}

function elapsed(started: number): number { return Math.max(0, Math.round(performance.now() - started)); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function abortError(signal: AbortSignal): Error { const error = signal.reason instanceof Error ? signal.reason : new Error("Cross-system tool call cancelled."); error.name = "AbortError"; return error; }
