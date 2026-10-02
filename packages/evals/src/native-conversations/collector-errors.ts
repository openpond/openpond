import type { CollectorStore } from "./collector-store.js";

export type CollectorErrorPhase =
  | "source"
  | "heartbeat"
  | "admission"
  | "control";
type Failures = Partial<Record<CollectorErrorPhase, string>>;
const phases: CollectorErrorPhase[] = [
  "source",
  "admission",
  "control",
  "heartbeat",
];

/** A recovered network probe cannot erase a durable unreadable-source or
 * unacknowledged-admission failure, including after a collector restart. */
export class CollectorErrors {
  constructor(private readonly store: CollectorStore) {}

  private read(id: string): Failures {
    const retained = this.store.setting(`errors:${id}`);
    if (retained) return JSON.parse(retained) as Failures;
    const source = this.store.database
      .prepare(
        "SELECT error FROM backfill_units WHERE connection_id=? AND state='error' AND error IS NOT NULL ORDER BY session_key LIMIT 1",
      )
      .get(id);
    return typeof source?.error === "string" ? { source: source.error } : {};
  }

  message(id: string, exclude?: CollectorErrorPhase) {
    const failures = this.read(id);
    return (
      phases
        .filter((phase) => phase !== exclude)
        .map((phase) => failures[phase])
        .find(Boolean) ?? null
    );
  }

  source(id: string) {
    return this.read(id).source ?? null;
  }

  set(id: string, phase: CollectorErrorPhase, message: string | null) {
    const failures = this.read(id);
    if (message) failures[phase] = message.slice(0, 500);
    else delete failures[phase];
    this.store.set(`errors:${id}`, JSON.stringify(failures));
    this.store.error(id, this.message(id));
  }
}
