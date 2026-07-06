import type { Approval, RuntimeEvent, Session, Turn } from "@openpond/contracts";
import {
  DEFAULT_OPENPOND_COMMAND_ACCESS_MODE,
  OpenPondCommandAccessModeSchema,
} from "@openpond/contracts";
import type { PayloadRow, StoreData } from "../types.js";
import { now } from "../utils.js";
import { sanitizeRuntimeEvent } from "../runtime/runtime-event-sanitizer.js";

export type StorePayloadTable = "sessions" | "turns" | "events" | "approvals";

export type StoreDbReader = {
  allPayloadRows: (sql: string, params?: unknown[]) => Promise<PayloadRow[]>;
};

export type StoreDbWriter = {
  exec: (sql: string) => Promise<void>;
  run: (sql: string, params: unknown[]) => Promise<void>;
};

export async function readStorePayloads<T>(
  reader: StoreDbReader,
  table: StorePayloadTable
): Promise<T[]> {
  const rows = await reader.allPayloadRows(`SELECT payload FROM ${table} ORDER BY sort_index ASC`);
  return rows.map((row) => JSON.parse(row.payload) as T);
}

export function normalizeSessionPayload(value: unknown): Session {
  const session = value as Session & { openPondCommandAccessMode?: unknown };
  const parsed = OpenPondCommandAccessModeSchema.safeParse(session.openPondCommandAccessMode);
  return {
    ...session,
    openPondCommandAccessMode: parsed.success ? parsed.data : DEFAULT_OPENPOND_COMMAND_ACCESS_MODE,
  };
}

export async function readStoreData(reader: StoreDbReader): Promise<StoreData> {
  return {
    sessions: (await readStorePayloads<Session>(reader, "sessions")).map(normalizeSessionPayload),
    turns: await readStorePayloads<Turn>(reader, "turns"),
    events: (await readStorePayloads<RuntimeEvent>(reader, "events")).map(sanitizeRuntimeEvent),
    approvals: await readStorePayloads<Approval>(reader, "approvals"),
  };
}

export async function persistStoreData(data: StoreData, writer: StoreDbWriter): Promise<void> {
  const updatedAt = now();
  await writer.exec("BEGIN IMMEDIATE");
  try {
    await writer.exec("DELETE FROM approvals; DELETE FROM events; DELETE FROM turns; DELETE FROM sessions;");

    for (const [index, session] of data.sessions.entries()) {
      await writer.run("INSERT INTO sessions (id, sort_index, payload, updated_at) VALUES (?, ?, ?, ?)", [
        session.id,
        index,
        JSON.stringify(session),
        session.updatedAt,
      ]);
    }

    for (const [index, turn] of data.turns.entries()) {
      await writer.run(
        "INSERT INTO turns (id, session_id, provider_turn_id, status, sort_index, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          turn.id,
          turn.sessionId,
          turn.providerTurnId,
          turn.status,
          index,
          JSON.stringify(turn),
          turn.completedAt ?? turn.startedAt,
        ]
      );
    }

    for (const [index, runtimeEvent] of data.events.entries()) {
      const sequence = index + 1;
      await writer.run(
        "INSERT INTO events (id, session_id, turn_id, name, timestamp, sequence, sort_index, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
          runtimeEvent.id,
          runtimeEvent.sessionId ?? null,
          runtimeEvent.turnId ?? null,
          runtimeEvent.name,
          runtimeEvent.timestamp,
          sequence,
          index,
          JSON.stringify(runtimeEvent),
        ]
      );
    }

    for (const [index, approval] of data.approvals.entries()) {
      await writer.run(
        "INSERT INTO approvals (id, session_id, status, sort_index, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        [approval.id, approval.sessionId, approval.status, index, JSON.stringify(approval), updatedAt]
      );
    }

    await writer.exec("COMMIT");
  } catch (error) {
    await writer.exec("ROLLBACK");
    throw error;
  }
}
