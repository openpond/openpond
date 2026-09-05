import { createHash } from "node:crypto";
import { z } from "zod";
import { readOptionalFile, withFileLock } from "./private-file.js";
import { withLocalDatabase } from "./database.js";
import { storagePaths } from "./home.js";
import path from "node:path";
import { PersistenceError } from "./errors.js";

const browserStateSchema = z.strictObject({ conversations: z.record(z.string(), z.strictObject({
  activeTabId: z.string().nullable(),
  tabs: z.array(z.strictObject({ id: z.string().min(1), url: z.string(), title: z.string().nullable(), faviconUrl: z.string().nullable(), lastUpdatedAt: z.number().finite() })),
})) });
/** A Desktop that first connects after server migration can import metadata once, without replacing new tabs. */
export async function importBrowserMetadataOnce(home: string, source: string): Promise<void> {
  await withFileLock(path.join(storagePaths(home).runtime, "browser-metadata-import"), async () => {
    const text = await readOptionalFile(source);
    if (text === null) return;
    const parsed = browserStateSchema.safeParse(JSON.parse(text));
    if (!parsed.success) throw new PersistenceError({ code: "MIGRATION_CONFLICT", path: source, message: "Native browser tab metadata has an unsupported structure.", action: "Preserve this file and resolve the metadata format before retrying." });
    const id = `browser-import:${createHash("sha256").update(source).digest("hex")}`;
    withLocalDatabase(home, (db) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        if (!db.prepare("SELECT 1 FROM client_preferences WHERE id=?").get(id)) {
          for (const [conversationId, value] of Object.entries(parsed.data.conversations)) db.prepare("INSERT INTO browser_tab_state VALUES (?, ?, 1) ON CONFLICT(id) DO NOTHING").run(conversationId, JSON.stringify(value));
          db.prepare("INSERT INTO client_preferences VALUES (?, ?, 1)").run(id, JSON.stringify({ schemaVersion: "openpond.browserMetadataImport.v1", source, hash: createHash("sha256").update(text).digest("hex"), importedAt: new Date().toISOString() }));
        }
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    });
  });
}
