import type { Logger } from "@openpond/logging";
import type { OpenPondSqliteConnection } from "./sqlite/sqlite-driver.js";

/** Live accessors owned by one SqliteStoreCore, including its serialized writes. */
export type SqliteDomainContext = {
  readonly home: string;
  readonly storePath: string;
  readonly logger: Logger | undefined;
  readonly ready: Promise<void>;
  readonly db: OpenPondSqliteConnection | null;
  readonly database: OpenPondSqliteConnection;
  writeQueue: Promise<void>;
};

/** Feature stores share persistence authority, not one another's implementations. */
export class SqliteStoreDomain {
  constructor(private readonly context: SqliteDomainContext) { }

  protected get home() { return this.context.home; }
  protected get storePath() { return this.context.storePath; }
  protected get logger() { return this.context.logger; }
  protected get ready() { return this.context.ready; }
  protected get db() { return this.context.db; }
  protected get database() { return this.context.database; }
  protected get writeQueue() { return this.context.writeQueue; }
  protected set writeQueue(value: Promise<void>) { this.context.writeQueue = value; }

  protected async exec(sql: string): Promise<void> { this.database.exec(sql); }
  protected async run(sql: string, params: unknown[]): Promise<void> { this.database.run(sql, params); }
  protected async all<T>(sql: string, params: unknown[] = []): Promise<T[]> { return this.database.all<T>(sql, params); }
  protected async get<T>(sql: string, params: unknown[]): Promise<T | null> { return this.database.get<T>(sql, params); }

  protected async upsertPayload(sql: string, params: unknown[]): Promise<void> {
    await this.ready;
    const write = this.writeQueue.then(() => this.run(sql, params));
    this.writeQueue = write.catch(() => undefined);
    await write;
  }

  protected async listParsedPayloads<T>(sql: string, params: unknown[], parse: (value: unknown) => T): Promise<T[]> {
    await this.ready;
    await this.writeQueue;
    const rows = await this.all<{ payload: string; }>(sql, params);
    return rows.map(row => parse(JSON.parse(row.payload)));
  }

  protected async getParsedPayload<T>(sql: string, params: unknown[], parse: (value: unknown) => T): Promise<T | null> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<{ payload: string; }>(sql, params);
    return row ? parse(JSON.parse(row.payload)) : null;
  }
}
