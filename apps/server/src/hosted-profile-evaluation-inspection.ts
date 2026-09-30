import { z } from "zod";
import { OpenPondProfileRefSchema, SessionSchema, TurnSchema, RuntimeEventSchema, ModelUsageRecordSchema } from "@openpond/contracts";
import { AttemptReceiptSchema, TaskGradeSchema } from "@openpond/evals";
import { LocalProfileEvaluationRunSchema } from "./store/profile-evaluation-record.js";
import { ProfileEvaluationInspectionRequestSchema, inspectProfileEvaluationRun } from "./harness/profile-evaluation-run-inspection.js";

const requestSchema = z.object({
  profileRef: OpenPondProfileRefSchema, inspection: ProfileEvaluationInspectionRequestSchema,
  run: LocalProfileEvaluationRunSchema.nullable(), receipts: z.array(AttemptReceiptSchema).max(10_000),
  grades: z.array(TaskGradeSchema).max(10_000), sessions: z.array(SessionSchema).max(10_000),
  turns: z.array(TurnSchema).max(10_000), events: z.array(RuntimeEventSchema).max(10_000),
  usage: z.array(ModelUsageRecordSchema).max(10_000),
}).strict();

/** Owner/generation-scoped host reads use the native receipt and trace verifier. */
export async function inspectHostedProfileEvaluation(raw: unknown) {
  const input = requestSchema.parse(raw);
  const map = <T>(values: T[], key: (value: T) => string) => {
    const result = new Map<string, T>();
    for (const value of values) {
      const id = key(value);
      if (result.has(id)) throw new Error("Hosted evaluation inspection has duplicate evidence identities.");
      result.set(id, value);
    }
    return result;
  };
  const receipts = map(input.receipts, value => value.id);
  const grades = map(input.grades, value => value.contentHash);
  const sessions = map(input.sessions, value => value.id);
  const turns = map(input.turns, value => value.id);
  return inspectProfileEvaluationRun({ profileRef: input.profileRef, ...input.inspection,
    store: {
      getProfileEvaluationRun: async id => input.run?.manifest.id === id ? input.run : null,
      getProfileEvaluationReceipt: async id => receipts.get(id) ?? null,
      getProfileEvaluationGrade: async id => grades.get(id) ?? null,
      getSession: async id => sessions.get(id) ?? null,
      getTurn: async id => turns.get(id) ?? null,
      runtimeEventsForTurn: async id => input.events.filter(event => event.turnId === id),
      listModelUsageRecords: async query => input.usage.filter(value =>
        (!query?.sessionId || value.sessionId === query.sessionId) && (!query?.turnId || value.turnId === query.turnId)),
    },
  });
}

export async function runHostedProfileInspectionCli(args: string[]): Promise<void> {
  if (args.length !== 0) throw new Error("Hosted evaluation inspection uses bounded standard input.");
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > 32 * 1024 * 1024) throw new Error("Hosted evaluation inspection input is too large.");
    chunks.push(bytes);
  }
  const raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const result = raw.action === "compare" || raw.action === "report"
    ? await (await import("./hosted-profile-evaluation-control.js")).controlHostedProfileEvaluation(raw)
    : await inspectHostedProfileEvaluation(raw);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
