import {
  CROSS_SYSTEM_OPERATIONS_SCHEMA_VERSION,
  CROSS_SYSTEM_TOOL_CONTRACT_HASH,
  CrossSystemTrajectorySchema,
  type CrossSystemTrajectory,
  type CrossSystemTrajectoryStep,
  type CrossSystemVerifierResult,
} from "@openpond/contracts";

import { CrossSystemEnvironment } from "./environment.js";
import type { CrossSystemTask, CrossSystemWorld } from "./types.js";
import { verifyCrossSystemTrajectory } from "./verifier.js";

export async function buildExpertCrossSystemTrajectories(input: {
  worlds: CrossSystemWorld[];
  tasks: CrossSystemTask[];
}): Promise<{
  trajectories: CrossSystemTrajectory[];
  results: CrossSystemVerifierResult[];
}> {
  const worldById = new Map(input.worlds.map((world) => [world.id, world]));
  const selectedTasks = input.tasks.filter((task) => task.split === "train");
  const trajectories: CrossSystemTrajectory[] = [];
  const results: CrossSystemVerifierResult[] = [];

  for (const [ordinal, task] of selectedTasks.entries()) {
    const world = worldById.get(task.worldId);
    if (!world) throw new Error(`Missing world ${task.worldId}.`);
    const trajectory = await createExpertTrajectory({
      world,
      task,
      ordinal,
    });
    const result = verifyCrossSystemTrajectory({ task, trajectory });
    if (
      result.outcome !== "correct"
      || !result.rewardEligible
      || !result.exactAnswer
      || result.reward === null
    ) {
      throw new Error(
        `Expert trajectory ${trajectory.id} did not pass the exact verifier.`,
      );
    }
    trajectories.push(trajectory);
    results.push(result);
  }

  if (!trajectories.length) {
    throw new Error(
      "No train-split Cross-System tasks were available for expert review.",
    );
  }
  return { trajectories, results };
}

async function createExpertTrajectory(input: {
  world: CrossSystemWorld;
  task: CrossSystemTask;
  ordinal: number;
}): Promise<CrossSystemTrajectory> {
  const id = `cso_expert_${input.task.id}`;
  const environment = new CrossSystemEnvironment({
    attemptId: id,
    world: input.world,
    task: input.task,
  });
  const steps: CrossSystemTrajectoryStep[] = [
    {
      kind: "model",
      turn: 0,
      content:
        "I will reconcile the bounded synthetic systems before answering.",
    },
  ];
  let turn = 1;

  try {
    for (const call of toolCallsFor(input.task, input.world)) {
      const callId = `call_${turn}_${call.name}`;
      steps.push({
        kind: "tool_call",
        turn,
        callId,
        name: call.name,
        arguments: call.arguments,
      });
      try {
        const result = await environment.execute(call.name, call.arguments);
        const evidence = environment.evidence.at(-1)!;
        steps.push({
          kind: "tool_result",
          turn,
          callId,
          name: call.name,
          ok: true,
          result,
          rows: evidence.rows,
          bytes: evidence.bytes,
          durationMs: 0,
          error: null,
        });
      } catch (error) {
        const evidence = environment.evidence.at(-1);
        steps.push({
          kind: "tool_result",
          turn,
          callId,
          name: call.name,
          ok: false,
          result: null,
          rows: evidence?.rows ?? 0,
          bytes: evidence?.bytes ?? 0,
          durationMs: 0,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      turn += 1;
    }
  } finally {
    await environment.close();
  }

  steps.push({
    kind: "final",
    turn,
    content: `ANSWER: ${JSON.stringify(input.task.expectedAnswer)}`,
  });
  const startedAt = new Date(
    Date.UTC(2026, 6, 13, 0, input.ordinal, 0),
  ).toISOString();
  return CrossSystemTrajectorySchema.parse({
    schemaVersion: CROSS_SYSTEM_OPERATIONS_SCHEMA_VERSION,
    id,
    worldId: input.world.id,
    taskId: input.task.id,
    toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH,
    modelRef: null,
    status: "completed",
    steps,
    startedAt,
    completedAt: new Date(Date.parse(startedAt) + 3_000).toISOString(),
    infrastructureError: null,
    metadata: {
      baseline: "expert_authored",
      scriptedOutcome: "correct",
      approved: true,
      worldSeed: input.world.seed,
      worldSplit: input.world.split,
      worldDifficulty: input.world.difficulty,
    },
  });
}

function toolCallsFor(
  task: CrossSystemTask,
  world: CrossSystemWorld,
): Array<{
  name: "search_crm" | "query_billing" | "search_support" | "run_python";
  arguments: Record<string, unknown>;
}> {
  if (task.family === "renewal_exposure") {
    return renewalRiskToolCalls(world);
  }
  const accountIds = world.accounts.map((account) => account.accountId);
  return task.queryPlan.map(({ tool }) => {
    if (tool === "search_crm") {
      return {
        name: tool,
        arguments: {
          query: "*",
          fields: [
            "account_id",
            "name",
            "aliases",
            "contract_value_usd_cents",
            "renewal_date",
            "tier",
            "active_contract_id",
            "contract_term_months",
          ],
          cursor: null,
          limit: 50,
        },
      };
    }
    if (tool === "query_billing") {
      return {
        name: tool,
        arguments: {
          account_ids: accountIds,
          date_range: { from: "2025-01-01", to: "2027-12-31" },
          status: [
            "open",
            "overdue",
            "paid",
            "disputed",
            "scheduled",
            "void",
          ],
          cursor: null,
          limit: 50,
        },
      };
    }
    if (tool === "search_support") {
      return {
        name: tool,
        arguments: {
          account_ids: accountIds,
          severity: ["P1", "P2", "P3", "P4"],
          state: [
            "new",
            "investigating",
            "waiting_customer",
            "resolved",
            "closed",
          ],
          cursor: null,
          limit: 50,
        },
      };
    }
    return {
      name: tool,
      arguments: { code: "values = [1, 2, 3]\n_result = sum(values)" },
    };
  });
}

function renewalRiskToolCalls(
  world: CrossSystemWorld,
): Array<{
  name: "search_crm" | "query_billing" | "search_support" | "run_python";
  arguments: Record<string, unknown>;
}> {
  const cutoff = new Date(`${world.referenceDate}T00:00:00.000Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() + 30);
  const accountIds = world.accounts.map((account) => account.accountId);
  const accounts = world.accounts.map((account) => ({
    account_id: account.accountId,
    renewal_date: account.renewalDate,
  }));
  const invoices = world.invoices
    .filter(
      (invoice) =>
        accountIds.includes(invoice.accountId)
        && invoice.status === "overdue"
        && invoice.issuedDate >= "2025-01-01"
        && invoice.issuedDate <= world.referenceDate,
    )
    .map((invoice) => ({
      account_id: invoice.accountId,
      due_date: invoice.dueDate,
      currency: invoice.currency,
      amount_cents: invoice.amountCents,
      status: invoice.status,
    }));
  const supportCases = world.supportCases
    .filter(
      (supportCase) =>
        accountIds.includes(supportCase.accountId)
        && supportCase.severity === "P1"
        && ["new", "investigating", "waiting_customer"].includes(
          supportCase.state,
        ),
    )
    .map((supportCase) => ({
      account_id: supportCase.accountId,
      severity: supportCase.severity,
      state: supportCase.state,
    }));

  return [
    {
      name: "search_crm",
      arguments: {
        query: "*",
        fields: ["account_id", "renewal_date"],
        cursor: null,
        limit: 50,
      },
    },
    {
      name: "query_billing",
      arguments: {
        account_ids: accountIds,
        date_range: { from: "2025-01-01", to: world.referenceDate },
        status: ["overdue"],
        cursor: null,
        limit: 50,
      },
    },
    {
      name: "search_support",
      arguments: {
        account_ids: accountIds,
        severity: ["P1"],
        state: ["new", "investigating", "waiting_customer"],
        cursor: null,
        limit: 50,
      },
    },
    {
      name: "run_python",
      arguments: {
        code: renewalRiskJoinCode({
          accounts,
          invoices,
          supportCases,
          fxUsdMicros: world.fxUsdMicros,
          referenceDate: world.referenceDate,
          cutoffDate: cutoff.toISOString().slice(0, 10),
        }),
      },
    },
  ];
}

function renewalRiskJoinCode(input: {
  accounts: Array<{ account_id: string; renewal_date: string }>;
  invoices: Array<{
    account_id: string;
    due_date: string;
    currency: string;
    amount_cents: number;
    status: string;
  }>;
  supportCases: Array<{
    account_id: string;
    severity: string;
    state: string;
  }>;
  fxUsdMicros: Record<string, number>;
  referenceDate: string;
  cutoffDate: string;
}): string {
  return [
    "import json",
    `accounts = json.loads(${JSON.stringify(JSON.stringify(input.accounts))})`,
    `invoices = json.loads(${JSON.stringify(JSON.stringify(input.invoices))})`,
    `support_cases = json.loads(${JSON.stringify(JSON.stringify(input.supportCases))})`,
    `fx_usd_micros = json.loads(${JSON.stringify(JSON.stringify(input.fxUsdMicros))})`,
    `reference_date = ${JSON.stringify(input.referenceDate)}`,
    `cutoff_date = ${JSON.stringify(input.cutoffDate)}`,
    "near_term = {row['account_id'] for row in accounts if reference_date <= row['renewal_date'] <= cutoff_date}",
    "overdue_by_account = {}",
    "for row in invoices:",
    "    if row['account_id'] not in near_term or row['status'] != 'overdue' or row['due_date'] >= reference_date:",
    "        continue",
    "    usd_cents = (row['amount_cents'] * fx_usd_micros[row['currency']] + 500000) // 1000000",
    "    overdue_by_account[row['account_id']] = overdue_by_account.get(row['account_id'], 0) + usd_cents",
    "active_p1 = {row['account_id'] for row in support_cases if row['severity'] == 'P1' and row['state'] in {'new', 'investigating', 'waiting_customer'}}",
    "account_ids = sorted(account_id for account_id in near_term if overdue_by_account.get(account_id, 0) > 1000000 and account_id in active_p1)",
    "_result = {'account_ids': account_ids, 'total_overdue_usd_cents': sum(overdue_by_account[account_id] for account_id in account_ids)}",
  ].join("\n");
}
