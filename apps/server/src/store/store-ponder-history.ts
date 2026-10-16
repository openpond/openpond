import { createHash } from "node:crypto";
import { SqliteStoreDomain } from "./store-domain.js";
import { emptyMemoryViews, type MemoryViews } from "../openpond/ponder-history/view.js";
export type PonderOriginal = {
    index: number;
    hash: string;
    turnId?: string | null;
    message: import("@openpond/cloud").HostedChatMessage;
};
export type PonderHistoryState = {
    revision: number;
    failures?: Record<string, {
        attempts: number;
        error: string;
        retryAt: number;
    }>;
    summaryConfiguration?: Record<string, unknown>;
    sourceEvents?: import("@openpond/contracts").RuntimeEvent[];
    originals: PonderOriginal[];
    summaries: Record<string, string>;
    summarySourceHashes?: Record<string, string>;
    views: MemoryViews;
    pending: string[];
    leases?: Record<string, {
        owner: string;
        expiresAt: number;
    }>;
};
const schema = `CREATE TABLE IF NOT EXISTS ponder_history_state(session_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ponder_history_requests(request_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,payload TEXT NOT NULL);`;
export class SqlitePonderHistoryStore extends SqliteStoreDomain {
    async pendingPonderHistorySessions(): Promise<string[]> {
        await this.ready;
        await this.writeQueue;
        this.database.exec(schema);
        return this.database.all<{
            session_id: string;
            payload: string;
        }>("SELECT session_id,payload FROM ponder_history_state").filter(row => (JSON.parse(row.payload) as PonderHistoryState).pending.length > 0).map(row => row.session_id);
    }
    async readPonderHistory(sessionId: string): Promise<PonderHistoryState> {
        await this.ready;
        await this.writeQueue;
        this.database.exec(schema);
        const session = this.database.get<{
            payload: string;
        }>("SELECT payload FROM sessions WHERE id=?", [sessionId]);
        if (!session || JSON.parse(session.payload).systemKind !== "openpond.ponder")
            throw new Error("local_ponder_required");
        const row = this.database.get<{
            payload: string;
        }>("SELECT payload FROM ponder_history_state WHERE session_id=?", [sessionId]);
        return row ? JSON.parse(row.payload) : { revision: 0, originals: [], summaries: {}, views: emptyMemoryViews(), pending: [] };
    }
    async savePonderHistory(sessionId: string, expectedRevision: number, state: PonderHistoryState): Promise<boolean> {
        await this.ready;
        const write = this.writeQueue.then(() => {
            const db = this.database;
            db.exec(schema);
            db.exec("BEGIN IMMEDIATE");
            try {
                const current = db.get<{
                    revision: number;
                }>("SELECT revision FROM ponder_history_state WHERE session_id=?", [sessionId]);
                if ((current?.revision ?? 0) !== expectedRevision) {
                    db.exec("ROLLBACK");
                    return false;
                }
                const next = { ...state, revision: expectedRevision + 1 };
                db.run("INSERT INTO ponder_history_state VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload", [sessionId, next.revision, JSON.stringify(next)]);
                db.exec("COMMIT");
                return true;
            }
            catch (error) {
                db.exec("ROLLBACK");
                throw error;
            }
        });
        this.writeQueue = write.then(() => { }, () => { });
        return write;
    }
    async latestPonderHistoryRequest(turnId: string, sessionId: string): Promise<{
        messages: import("@openpond/cloud").HostedChatMessage[];
        metadata: Record<string, unknown>;
    } | null> {
        await this.ready;
        await this.writeQueue;
        this.database.exec(schema);
        const row = this.database.get<{
            payload: string;
        }>("SELECT payload FROM ponder_history_requests WHERE session_id=? AND request_id LIKE ? ORDER BY rowid DESC LIMIT 1", [sessionId, `${turnId}:optchat:%`]);
        return row ? JSON.parse(row.payload) : null;
    }
    async getPonderHistoryRequest(requestId: string, sessionId: string): Promise<{
        messages: import("@openpond/cloud").HostedChatMessage[];
        metadata: Record<string, unknown>;
    } | null> {
        await this.ready;
        await this.writeQueue;
        this.database.exec(schema);
        const row = this.database.get<{
            session_id: string;
            payload: string;
        }>("SELECT session_id,payload FROM ponder_history_requests WHERE request_id=?", [requestId]);
        if (row && row.session_id !== sessionId)
            throw new Error("ponder_history_request_scope_invalid");
        return row ? JSON.parse(row.payload) : null;
    }
    async admitPonderHistoryRequest(requestId: string, sessionId: string, messages: import("@openpond/cloud").HostedChatMessage[], metadata: Record<string, unknown> = {}) {
        await this.ready;
        const write = this.writeQueue.then(() => {
            this.database.exec(schema);
            this.database.run("INSERT OR IGNORE INTO ponder_history_requests VALUES(?,?,?)", [requestId, sessionId, JSON.stringify({ messages, metadata })]);
            const row = this.database.get<{
                session_id: string;
                payload: string;
            }>("SELECT session_id,payload FROM ponder_history_requests WHERE request_id=?", [requestId]);
            if (!row || row.session_id !== sessionId)
                throw new Error("ponder_history_request_scope_invalid");
            return (JSON.parse(row.payload) as {
                messages: import("@openpond/cloud").HostedChatMessage[];
            }).messages;
        });
        this.writeQueue = write.then(() => { }, () => { });
        return write;
    }
}
export function ponderOriginalHash(message: import("@openpond/cloud").HostedChatMessage) { return createHash("sha256").update(JSON.stringify(message)).digest("hex"); }
