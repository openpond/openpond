import { advancedPublishedWorkAssets } from "./advanced-refiner-work-assets.js";
import type { Taskset, TaskDataRecord } from "@openpond/contracts";
import type { TasksetPackage } from "openpond-sdk/taskset-packages";
import type { ResolvedTasksetWorkAsset } from "./taskset-work-assets.js";
import { prepareLocalExperimentModel } from "../evaluations/local-experiment-model.js";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { contentHash } from "@openpond/harness";
import { openStorageDatabase } from "@openpond/persistence";
import {
  verifyAdvancedRefinerEvaluationPin,
  type AdvancedRefinerEvaluationPin,
} from "openpond-sdk/advanced-refiner-evaluations";
import type { HostedTokenPricing } from "./hosted-token-pricing.js";

type Guard = {
  runId: string;
  pin: AdvancedRefinerEvaluationPin;
  signal: AbortSignal;
  authorize(): Promise<void>;
  resolveWorkAssets(
    taskset: Taskset,
    task: TaskDataRecord,
  ): Promise<ResolvedTasksetWorkAsset[]>;
  call<T>(
    id: string,
    intent: unknown,
    pricing: HostedTokenPricing,
    maximumOutputTokens: number,
    execute: () => Promise<{ value: T; costUsd: number | null }>,
  ): Promise<T>;
};
const scopes = new AsyncLocalStorage<Guard>();
/** Every advanced foreground, grader and Refiner request shares this durable
 * ceiling. Unknown paid responses retain their reservation and cannot retry. */
export function currentAdvancedRefinerBoundary() {
  return scopes.getStore();
}
export function createAdvancedRefinerPaidBoundary(deps: {
  storeDir: string;
  authorize(pin: AdvancedRefinerEvaluationPin): Promise<void>;
  packageForPin(pin: AdvancedRefinerEvaluationPin): Promise<TasksetPackage>;
  prepareModel?(modelId:string,maximumOutputTokens:number,pricing:HostedTokenPricing):Promise<{configurationHash:string;maximumChargeUsd:number}>;
}) {
  const db = openStorageDatabase(
    path.join(
      deps.storeDir,
      "library",
      "harnesses",
      "advanced-refiner-paid-calls.sqlite",
    ),
  );
  db.exec(`CREATE TABLE IF NOT EXISTS advanced_refiner_budgets(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,team_id TEXT NOT NULL,pin_hash TEXT NOT NULL,maximum_spend REAL NOT NULL,maximum_steps INTEGER NOT NULL,expires_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS advanced_refiner_calls(run_id TEXT NOT NULL,id TEXT NOT NULL,intent_hash TEXT NOT NULL,ceiling REAL NOT NULL,state TEXT NOT NULL,actual_spend REAL,result TEXT,PRIMARY KEY(run_id,id));`);
  function transaction<T>(fn: () => T) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  async function run<T>(
    runId: string,
    raw: AdvancedRefinerEvaluationPin,
    execute: () => Promise<T>,
  ) {
    const pin = verifyAdvancedRefinerEvaluationPin(raw);
    await deps.authorize(pin);
    transaction(() => {
      const old = db
        .prepare("SELECT * FROM advanced_refiner_budgets WHERE id=?")
        .get(runId);
      if (old) {
        if (
          old.actor_id !== pin.actorId ||
          old.team_id !== pin.teamId ||
          old.pin_hash !== pin.contentHash
        )
          throw new Error(
            "Advanced Run budget belongs to another immutable admission.",
          );
        return;
      }
      db.prepare(
        "INSERT INTO advanced_refiner_budgets VALUES(?,?,?,?,?,?,?)",
      ).run(
        runId,
        pin.actorId,
        pin.teamId,
        pin.contentHash,
        pin.maximumCostUsd,
        pin.maximumModelSteps,
        new Date(Date.now() + pin.maximumDurationMs).toISOString(),
      );
    });
    const expiry = db
      .prepare("SELECT expires_at FROM advanced_refiner_budgets WHERE id=?")
      .get(runId)!;
    const remaining = Date.parse(String(expiry.expires_at)) - Date.now();
    if (remaining <= 0)
      throw new Error(
        "The immutable advanced evaluation duration is exhausted.",
      );
    const guard: Guard = {
      runId,
      pin,
      signal: AbortSignal.timeout(remaining),
      authorize: () => deps.authorize(pin),
      async resolveWorkAssets(taskset, task) {
        await deps.authorize(pin);
        guard.signal.throwIfAborted();
        const value = await deps.packageForPin(pin);
        const assets = advancedPublishedWorkAssets(value, taskset, task);
        await deps.authorize(pin);
        guard.signal.throwIfAborted();
        return assets;
      },
      async call<T>(
        id: string,
        intent: unknown,
        pricing: HostedTokenPricing,
        maximumOutputTokens: number,
        provider: () => Promise<{ value: T; costUsd: number | null }>,
      ) {
        await deps.authorize(pin);
        if (!Number.isInteger(maximumOutputTokens) || maximumOutputTokens < 1)
          throw new Error(
            "Advanced paid requests require a finite enforced token ceiling.",
          );
        const target = (
          intent as { model?: { providerId?: string; modelId?: string } }
        ).model;
        if (target?.providerId !== "openpond" || !target.modelId)
          throw new Error(
            "Advanced paid calls require an explicitly qualified hosted model.",
          );
        const modelId=target.modelId;
        const prepared=deps.prepareModel?await deps.prepareModel(modelId,maximumOutputTokens,pricing):await (async()=>{
          const value=await prepareLocalExperimentModel({kind:"hosted_chat",modelId,maxOutputTokens:maximumOutputTokens,temperature:0,topP:1});
          if(contentHash(value.pricing)!==contentHash(pricing))throw new Error("The actual model pricing differs from its reviewed request pin.");
          return{configurationHash:value.model.configurationHash,maximumChargeUsd:value.maximumChargeUsd};
        })();
        if(!/^[a-f0-9]{64}$/.test(prepared.configurationHash)||!Number.isFinite(prepared.maximumChargeUsd)||prepared.maximumChargeUsd<=0)throw new Error("The actual owner model ceiling is unavailable.");
        const intentHash=contentHash({intent,pricing,maximumOutputTokens,modelConfigurationHash:prepared.configurationHash}),ceiling=prepared.maximumChargeUsd;
        const prior = transaction(() => {
          const budget = db
            .prepare("SELECT * FROM advanced_refiner_budgets WHERE id=?")
            .get(runId);
          if (!budget || String(budget.expires_at) <= new Date().toISOString())
            throw new Error(
              "The immutable advanced evaluation duration is exhausted.",
            );
          const retained = db
            .prepare(
              "SELECT * FROM advanced_refiner_calls WHERE run_id=? AND id=?",
            )
            .get(runId, id);
          if (retained) {
            if (retained.intent_hash !== intentHash)
              throw new Error(
                "Advanced provider request ID retains another exact payload.",
              );
            if (retained.state !== "completed")
              throw new Error(
                "This paid request has an unknown outcome; recover its actual provider receipt before resuming.",
              );
            return JSON.parse(String(retained.result)) as T;
          }
          const sum = db
            .prepare(
              "SELECT COUNT(*) AS steps,COALESCE(SUM(COALESCE(actual_spend,ceiling)),0) AS spent,SUM(CASE WHEN state NOT IN ('completed','not_dispatched') THEN 1 ELSE 0 END) AS unknown FROM advanced_refiner_calls WHERE run_id=?",
            )
            .get(runId)!;
          if (Number(sum.unknown) > 0)
            throw new Error(
              "A prior advanced paid request is unsettled; no fresh request is allowed.",
            );
          if (
            Number(sum.steps) >= pin.maximumModelSteps ||
            Number(sum.spent) + ceiling > pin.maximumCostUsd + 1e-9
          )
            throw new Error(
              "The advanced evaluation step or cumulative spend ceiling is exhausted.",
            );
          db.prepare(
            "INSERT INTO advanced_refiner_calls(run_id,id,intent_hash,ceiling,state) VALUES(?,?,?,?,?)",
          ).run(runId, id, intentHash, ceiling, "reserved");
          return undefined;
        });
        if (prior !== undefined) {
          await deps.authorize(pin);
          guard.signal.throwIfAborted();
          return prior;
        }
        let dispatched = false;
        try {
          await deps.authorize(pin);
          guard.signal.throwIfAborted();
          const claimed = db
            .prepare(
              "UPDATE advanced_refiner_calls SET state='dispatched' WHERE run_id=? AND id=? AND intent_hash=? AND state='reserved'",
            )
            .run(runId, id, intentHash);
          if (claimed.changes !== 1)
            throw new Error("The retained advanced request admission changed.");
          dispatched = true;
          const receipt = await provider();
          if (
            receipt.costUsd === null ||
            !Number.isFinite(receipt.costUsd) ||
            receipt.costUsd < 0 ||
            receipt.costUsd > ceiling + 1e-9
          )
            throw new Error(
              "The actual provider receipt cannot settle its admitted request ceiling.",
            );
          const encoded = JSON.stringify(receipt.value);
          if (Buffer.byteLength(encoded) > 8 * 1024 * 1024)
            throw new Error(
              "The advanced provider response exceeds the retained output bound.",
            );
          transaction(() => {
            const result = db
              .prepare(
                "UPDATE advanced_refiner_calls SET state='completed',actual_spend=?,result=? WHERE run_id=? AND id=? AND intent_hash=? AND state='dispatched'",
              )
              .run(receipt.costUsd, encoded, runId, id, intentHash);
            if (result.changes !== 1)
              throw new Error(
                "The advanced request settlement changed concurrently.",
              );
          });
          await deps.authorize(pin);
          return receipt.value;
        } catch (error) {
          if (dispatched)
            db.prepare(
              "UPDATE advanced_refiner_calls SET state='unknown' WHERE run_id=? AND id=? AND state='dispatched'",
            ).run(runId, id);
          else
            db.prepare(
              "UPDATE advanced_refiner_calls SET state='not_dispatched',actual_spend=0 WHERE run_id=? AND id=? AND state='reserved'",
            ).run(runId, id);
          throw error;
        }
      },
    };
    return scopes.run(guard, execute);
  }
  return {
    run,
    async authorize(pin: AdvancedRefinerEvaluationPin) {
      await deps.authorize(verifyAdvancedRefinerEvaluationPin(pin));
    },
    read(runId: string, pin: AdvancedRefinerEvaluationPin) {
      const row = db
        .prepare(
          "SELECT * FROM advanced_refiner_budgets WHERE id=? AND actor_id=? AND team_id=? AND pin_hash=?",
        )
        .get(runId, pin.actorId, pin.teamId, pin.contentHash);
      if (!row) return null;
      return db
        .prepare(
          "SELECT id,intent_hash,ceiling,state,actual_spend FROM advanced_refiner_calls WHERE run_id=? ORDER BY id",
        )
        .all(runId);
    },
    accounting(runId: string, pin: AdvancedRefinerEvaluationPin) {
      const calls = this.read(runId, pin) ?? [];
      const unsettled = calls.filter(
        (call) => call.state !== "completed" && call.state !== "not_dispatched",
      );
      const knownSpendUsd = calls.reduce(
        (sum, call) => sum + Number(call.actual_spend ?? 0),
        0,
      );
      return {
        modelRequests: calls.filter((call) => call.state !== "not_dispatched")
          .length,
        knownSpendUsd,
        totalSpendUsd: unsettled.length ? null : knownSpendUsd,
        heldUsd: unsettled.reduce((sum, call) => sum + Number(call.ceiling), 0),
        uncertainRequests: unsettled.filter((call) => call.state !== "reserved")
          .length,
      };
    },
    close() {
      db.close();
    },
  };
}
