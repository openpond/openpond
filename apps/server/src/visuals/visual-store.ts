import { withLocalDatabase } from "@openpond/persistence";
import type { HtmlVisualReference } from "@openpond/contracts/html-visuals";
export type VisualPublication = {
  reference: HtmlVisualReference;
  callKey: string;
  document: string | null;
  screenshot: string | null;
  ready: boolean;
};
// Publication intents live alongside existing managed artifacts, not in a new
// database. Pending bytes form a recoverable outbox until the event is durable.
export function createVisualStore(home: string) {
  function db<T>(action: Parameters<typeof withLocalDatabase<T>>[1]): T {
    return withLocalDatabase(home, database => {
      database.exec(`CREATE TABLE IF NOT EXISTS html_visual_publications (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, call_key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS html_visual_session ON html_visual_publications(session_id);`);
      return action(database);
    });
  }
  return {
    get(id: string): VisualPublication | null {
      return db(database => { const row = database.prepare("SELECT payload FROM html_visual_publications WHERE id=?").get(id) as {
        payload: string;
      } | undefined; return row ? JSON.parse(row.payload) : null; });
    },
    byCall(callKey: string): VisualPublication | null {
      return db(database => { const row = database.prepare("SELECT payload FROM html_visual_publications WHERE call_key=?").get(callKey) as {
        payload: string;
      } | undefined; return row ? JSON.parse(row.payload) : null; });
    },
    list(sessionId?: string): VisualPublication[] {
      return db(database => ((sessionId
        ? database.prepare("SELECT payload FROM html_visual_publications WHERE session_id=?").all(sessionId)
        : database.prepare("SELECT payload FROM html_visual_publications").all()) as {
        payload: string;
      }[]).map(row => JSON.parse(row.payload)));
    },
    save(publication: VisualPublication): void {
      db(database => {
        database.prepare("INSERT INTO html_visual_publications VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload")
          .run(publication.reference.publicationId, publication.reference.sessionId, publication.callKey, JSON.stringify(publication));
      });
    },
    delete(id: string): void { db(database => { database.prepare("DELETE FROM html_visual_publications WHERE id=?").run(id); }); },
  };
}
