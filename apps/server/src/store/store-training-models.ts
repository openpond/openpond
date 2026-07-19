import type {
  FireworksModelServingSession,
  ModelBinding,
  RolloutTrajectoryReceipt,
} from "@openpond/contracts";
import {
  FireworksModelServingSessionSchema,
  ModelBindingSchema,
  RolloutTrajectoryReceiptSchema,
} from "@openpond/contracts";
import type { PayloadRow } from "../types.js";
import { SqliteStoreCore } from "./store-core.js";

export class SqliteTrainingModelStore extends SqliteStoreCore {
  async saveFireworksModelServingSession(
    sessionInput: FireworksModelServingSession,
  ): Promise<FireworksModelServingSession> {
    const session = FireworksModelServingSessionSchema.parse(sessionInput);
    await this.upsertPayload(
      `INSERT INTO fireworks_model_serving_sessions
        (id, profile_id, model_artifact_lineage_id, state, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         profile_id = excluded.profile_id,
         model_artifact_lineage_id = excluded.model_artifact_lineage_id,
         state = excluded.state,
         payload = excluded.payload,
         updated_at = excluded.updated_at`,
      [
        session.id,
        session.profileId,
        session.modelArtifactLineageId,
        session.state,
        JSON.stringify(session),
        session.createdAt,
        session.updatedAt,
      ],
    );
    return session;
  }

  async getFireworksModelServingSession(id: string): Promise<FireworksModelServingSession | null> {
    return this.getParsedPayload(
      "SELECT payload FROM fireworks_model_serving_sessions WHERE id = ?",
      [id],
      FireworksModelServingSessionSchema.parse,
    );
  }

  async listFireworksModelServingSessions(input: {
    profileId?: string;
    modelArtifactLineageId?: string;
  } = {}): Promise<FireworksModelServingSession[]> {
    if (input.profileId) {
      return this.listParsedPayloads(
        "SELECT payload FROM fireworks_model_serving_sessions WHERE profile_id = ? ORDER BY updated_at DESC",
        [input.profileId],
        FireworksModelServingSessionSchema.parse,
      );
    }
    if (input.modelArtifactLineageId) {
      return this.listParsedPayloads(
        "SELECT payload FROM fireworks_model_serving_sessions WHERE model_artifact_lineage_id = ? ORDER BY updated_at DESC",
        [input.modelArtifactLineageId],
        FireworksModelServingSessionSchema.parse,
      );
    }
    return this.listParsedPayloads(
      "SELECT payload FROM fireworks_model_serving_sessions ORDER BY updated_at DESC",
      [],
      FireworksModelServingSessionSchema.parse,
    );
  }

  async saveRolloutTrajectoryReceipt(
    receiptInput: RolloutTrajectoryReceipt,
  ): Promise<RolloutTrajectoryReceipt> {
    const receipt = RolloutTrajectoryReceiptSchema.parse(receiptInput);
    await this.upsertPayload(
      `INSERT INTO training_rollout_receipts (id, job_id, taskset_id, provider_rollout_id, status, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET job_id = excluded.job_id, taskset_id = excluded.taskset_id,
         provider_rollout_id = excluded.provider_rollout_id, status = excluded.status,
         payload = excluded.payload, updated_at = excluded.updated_at`,
      [
        receipt.id,
        receipt.jobId,
        receipt.tasksetId,
        receipt.providerTrace.rolloutId,
        receipt.status,
        JSON.stringify(receipt),
        receipt.receivedAt,
        receipt.updatedAt,
      ],
    );
    return receipt;
  }

  async getRolloutTrajectoryReceiptByProviderId(
    providerRolloutId: string,
  ): Promise<RolloutTrajectoryReceipt | null> {
    return this.getParsedPayload(
      "SELECT payload FROM training_rollout_receipts WHERE provider_rollout_id = ?",
      [providerRolloutId],
      RolloutTrajectoryReceiptSchema.parse,
    );
  }

  async listRolloutTrajectoryReceipts(input: {
    jobId?: string;
    tasksetId?: string;
  } = {}): Promise<RolloutTrajectoryReceipt[]> {
    if (input.jobId) {
      return this.listParsedPayloads(
        "SELECT payload FROM training_rollout_receipts WHERE job_id = ? ORDER BY updated_at DESC",
        [input.jobId],
        RolloutTrajectoryReceiptSchema.parse,
      );
    }
    if (input.tasksetId) {
      return this.listParsedPayloads(
        "SELECT payload FROM training_rollout_receipts WHERE taskset_id = ? ORDER BY updated_at DESC",
        [input.tasksetId],
        RolloutTrajectoryReceiptSchema.parse,
      );
    }
    return this.listParsedPayloads(
      "SELECT payload FROM training_rollout_receipts ORDER BY updated_at DESC",
      [],
      RolloutTrajectoryReceiptSchema.parse,
    );
  }

  async saveModelBinding(bindingInput: ModelBinding): Promise<ModelBinding> {
    const binding = ModelBindingSchema.parse(bindingInput);
    await this.upsertPayload(
      `INSERT INTO model_bindings (id, profile_id, role, role_target_id, model_artifact_lineage_id, status, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET profile_id = excluded.profile_id, role = excluded.role,
         role_target_id = excluded.role_target_id, model_artifact_lineage_id = excluded.model_artifact_lineage_id,
         status = excluded.status, payload = excluded.payload, updated_at = excluded.updated_at`,
      [
        binding.id,
        binding.profileId,
        binding.role,
        binding.roleTargetId,
        binding.modelArtifactLineageId,
        binding.status,
        JSON.stringify(binding),
        binding.promotedAt,
        binding.rolledBackAt ?? binding.promotedAt,
      ],
    );
    return binding;
  }

  async replaceActiveModelBinding(input: {
    profileId: string;
    role: ModelBinding["role"];
    roleTargetId: string;
    expectedActiveBindingId: string | null;
    next: ModelBinding | null;
    timestamp: string;
  }): Promise<{ previous: ModelBinding | null; active: ModelBinding | null }> {
    const next = input.next ? ModelBindingSchema.parse(input.next) : null;
    if (
      next
      && (
        next.status !== "active"
        || next.profileId !== input.profileId
        || next.role !== input.role
        || next.roleTargetId !== input.roleTargetId
      )
    ) {
      throw new Error("Replacement Model binding does not match the requested active role.");
    }
    await this.ready;
    let result: { previous: ModelBinding | null; active: ModelBinding | null } = {
      previous: null,
      active: null,
    };
    const write = this.writeQueue.then(async () => {
      await this.exec("BEGIN IMMEDIATE");
      try {
        const row = await this.get<PayloadRow>(
          "SELECT payload FROM model_bindings WHERE profile_id = ? AND role = ? AND role_target_id = ? AND status = 'active' LIMIT 1",
          [input.profileId, input.role, input.roleTargetId],
        );
        const current = row ? ModelBindingSchema.parse(JSON.parse(row.payload)) : null;
        if ((current?.id ?? null) !== input.expectedActiveBindingId) {
          throw new Error("The active Model binding changed before this promotion could be applied.");
        }
        if (current) {
          const rolledBack = ModelBindingSchema.parse({
            ...current,
            status: "rolled_back",
            rolledBackAt: input.timestamp,
          });
          await this.run(
            `UPDATE model_bindings
             SET status = 'rolled_back', payload = ?, updated_at = ?
             WHERE id = ? AND status = 'active'`,
            [JSON.stringify(rolledBack), input.timestamp, current.id],
          );
        }
        if (next) {
          await this.run(
            `INSERT INTO model_bindings
              (id, profile_id, role, role_target_id, model_artifact_lineage_id, status, payload, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              next.id,
              next.profileId,
              next.role,
              next.roleTargetId,
              next.modelArtifactLineageId,
              next.status,
              JSON.stringify(next),
              next.promotedAt,
              next.promotedAt,
            ],
          );
        }
        await this.exec("COMMIT");
        result = { previous: current, active: next };
      } catch (error) {
        await this.exec("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return result;
  }

  async getModelBinding(id: string): Promise<ModelBinding | null> {
    return this.getParsedPayload(
      "SELECT payload FROM model_bindings WHERE id = ?",
      [id],
      ModelBindingSchema.parse,
    );
  }

  async getActiveModelBinding(input: {
    profileId: string;
    role: ModelBinding["role"];
    roleTargetId: string;
  }): Promise<ModelBinding | null> {
    return this.getParsedPayload(
      "SELECT payload FROM model_bindings WHERE profile_id = ? AND role = ? AND role_target_id = ? AND status = 'active' LIMIT 1",
      [input.profileId, input.role, input.roleTargetId],
      ModelBindingSchema.parse,
    );
  }

  async listModelBindings(profileId?: string): Promise<ModelBinding[]> {
    return this.listParsedPayloads(
      profileId
        ? "SELECT payload FROM model_bindings WHERE profile_id = ? ORDER BY updated_at DESC"
        : "SELECT payload FROM model_bindings ORDER BY updated_at DESC",
      profileId ? [profileId] : [],
      ModelBindingSchema.parse,
    );
  }

  protected async upsertPayload(sql: string, params: unknown[]): Promise<void> {
    await this.ready;
    const write = this.writeQueue.then(() => this.run(sql, params));
    this.writeQueue = write.catch(() => undefined);
    await write;
  }

  protected async listParsedPayloads<T>(
    sql: string,
    params: unknown[],
    parse: (value: unknown) => T,
  ): Promise<T[]> {
    await this.ready;
    await this.writeQueue;
    const rows = await this.all<PayloadRow>(sql, params);
    return rows.map((row) => parse(JSON.parse(row.payload)));
  }

  protected async getParsedPayload<T>(
    sql: string,
    params: unknown[],
    parse: (value: unknown) => T,
  ): Promise<T | null> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<PayloadRow>(sql, params);
    return row ? parse(JSON.parse(row.payload)) : null;
  }
}
