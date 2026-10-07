import { SqliteChatStore } from "./store-chat.js";
import type { SqliteStoreCoreOptions } from "./store-core.js";
import { StoreDomainLifecycle } from "./store-domain-loader.js";
import { runtimeStoreMethods } from "./domains/runtime-store-methods.js";
import { trainingStoreMethods } from "./domains/training-store-methods.js";
import { evaluationStoreMethods } from "./domains/evaluation-store-methods.js";

export { CURRENT_SQLITE_SCHEMA_VERSION } from "./store-schema.js";
export type { ThreadDetailProjection } from "./store-codecs.js";
export type { TrainingChatSearchDocument } from "./store-training.js";

type DomainMethods = ReturnType<typeof runtimeStoreMethods> & ReturnType<typeof trainingStoreMethods> & ReturnType<typeof evaluationStoreMethods>;

// Implementations are installed together below; type inference keeps the facade
// aligned with the domain methods without importing their runtime modules.
export interface SqliteStore extends DomainMethods {}
export class SqliteStore extends SqliteChatStore {
  private readonly domains = new StoreDomainLifecycle();
  private closing: Promise<void> | undefined;

  constructor(storeDir: string, options: SqliteStoreCoreOptions = {}) {
    super(storeDir, options);
    const context = this.domainContext();
    Object.assign(this,
      runtimeStoreMethods(context, this.domains),
      trainingStoreMethods(context, this.domains),
      evaluationStoreMethods(context, this.domains),
    );
  }

  override close(): Promise<void> {
    return this.closing ??= this.domains.close().then(() => super.close());
  }
}
