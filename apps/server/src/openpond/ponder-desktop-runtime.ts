import { publishPonderDesktopCatalog } from "./ponder-desktop-publication.js";
import { z } from "zod";
import {
  PONDER_DESKTOP_RENEW_MS,
  PonderDesktopAttachmentSchema,
  PonderDesktopOperationSchema,
  PonderDesktopInspectionSchema,
  type PonderDesktopInspection,
  type PonderDesktopAttachment,
  type PonderDesktopCatalog,
  type PonderDesktopOperation,
  type PonderDesktopReservationResume,
} from "@openpond/contracts";
import type { PonderDesktopResult } from "@openpond/contracts";
import type { createPonderDesktopClient } from "./ponder-desktop-client.js";
import type { PonderLocalOwner } from "./ponder-local-scope.js";

type Client = ReturnType<typeof createPonderDesktopClient>;
type Receipt = NonNullable<PonderDesktopOperation["receipt"]>;
/** Outbound only, independent of pane lifetime. One captured login owns each lease. */
export function createPonderDesktopRuntime(deps: {
  client: Client;
  owner: PonderLocalOwner;
  publicKey: string;
  reauthorizationGeneration?: number;
  catalog(): Promise<PonderDesktopCatalog>;
  stillOwned(): Promise<boolean>;
  setAuthority(attachment: PonderDesktopAttachment): Promise<void>;
  clearAuthority(runtimeId: string): Promise<void>;
  recover(operation: PonderDesktopOperation): Promise<Receipt | null>;
  reservation(
    operation: PonderDesktopOperation,
    owner: PonderLocalOwner,
  ): Promise<PonderDesktopReservationResume | null>;
  execute(
    operation: PonderDesktopOperation,
    owner: PonderLocalOwner,
    resume?: PonderDesktopReservationResume,
  ): Promise<Receipt>;
  result(operation: PonderDesktopOperation): Promise<PonderDesktopResult | null>;
  inspection(operation: PonderDesktopOperation): Promise<PonderDesktopInspection | null>;
  warn(message: string): void;
}) {
  let attachment: PonderDesktopAttachment | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let pollingNeeded = true;
  let wakeGeneration = 0;
  const operations = new Map<string, PonderDesktopOperation>();
  let cloudObligations = false;

  async function saveAttachment(value: unknown) {
    const next = PonderDesktopAttachmentSchema.parse(value);
    if (
      next.runtimeId !== deps.client.runtimeId ||
      next.state !== "attached" ||
      next.publicKey !== deps.publicKey ||
      next.reauthorizationGeneration !== (deps.reauthorizationGeneration ?? 0) ||
      !Object.entries(deps.client.scope).every(
        ([key, entry]) => next.scope[key as keyof typeof next.scope] === entry,
      )
    ) {
      throw new Error("ponder_desktop_attachment_identity_changed");
    }
    if (stopped || !(await deps.stillOwned()))
      throw new Error("ponder_desktop_runtime_owner_changed");
    await deps.setAuthority(next);
    attachment = next;
  }

  async function acknowledge(operation: PonderDesktopOperation, receipt: Receipt) {
    if (!attachment || !operation.claimId) throw new Error("ponder_desktop_claim_required");
    const response = await deps.client.request(
      "admission",
      {
        operationId: operation.id,
        payloadHash: operation.payloadHash,
        claimId: operation.claimId,
        receipt,
      },
      attachment.epoch,
    );
    const admitted = z.object({ operation: PonderDesktopOperationSchema }).parse(response).operation;
    if (["completed", "failed", "cancelled", "expired"].includes(admitted.state)) operations.delete(admitted.id);
    else operations.set(admitted.id, admitted);
  }

  async function processOperation(observed: PonderDesktopOperation) {
    if (stopped || !attachment) return;
    if (observed.state === "admitted") {
      const receipt = await deps.recover(observed);
      if (receipt && JSON.stringify(receipt) !== JSON.stringify(observed.receipt))
        await acknowledge(observed, receipt);
      if (observed.intent.action === "inspect") {
        const value = await deps.inspection(observed);
        if (!value || stopped || !(await deps.stillOwned())) return;
        if (stopped || !attachment) return;
        const inspection = PonderDesktopInspectionSchema.parse(value);
        if (inspection.operationId !== observed.id || inspection.payloadHash !== observed.payloadHash ||
            inspection.sessionId !== observed.intent.targetId || inspection.turnId !== observed.intent.expectedTurnId ||
            receipt?.sessionId !== inspection.sessionId || receipt.turnId !== inspection.turnId ||
            receipt.inputId !== null || receipt.state !== "inspected")
          throw new Error("ponder_desktop_inspection_receipt_changed");
        await deps.client.request("inspection", inspection, attachment.epoch);
        operations.delete(observed.id);
        return;
      }
      const result = await deps.result(observed);
      if (result) { await deps.client.request("result", result, attachment.epoch); operations.delete(observed.id); }
      return;
    }
    if (observed.state === "dispatching" || observed.state === "attention") {
      const receipt = await deps.recover(observed);
      if (receipt) {
        await acknowledge(observed, receipt);
        return;
      }
      const reservation = await deps.reservation(observed, deps.owner);
      if (!reservation || stopped || !(await deps.stillOwned())) return;
      const resumed = z
        .object({
          operation: PonderDesktopOperationSchema,
          claimed: z.boolean(),
        })
        .parse(
          await deps.client.request(
            "claim",
            {
              operationId: observed.id,
              payloadHash: observed.payloadHash,
              resume: { claimId: observed.claimId, reservation },
            },
            attachment.epoch,
          ),
        );
      if (resumed.claimed) {
        if (stopped || !(await deps.stillOwned())) return;
        await acknowledge(
          resumed.operation,
          await deps.execute(resumed.operation, deps.owner, reservation),
        );
      }
      return;
    }
    if (observed.state !== "ready") return;
    const result = z
      .object({ operation: PonderDesktopOperationSchema, claimed: z.boolean() })
      .parse(
        await deps.client.request(
          "claim",
          { operationId: observed.id, payloadHash: observed.payloadHash },
          attachment.epoch,
        ),
      );
    if (!result.claimed) return;
    const operation = result.operation;
    try {
      if (stopped || !(await deps.stillOwned()))
        throw new Error("ponder_desktop_runtime_owner_changed");
      await acknowledge(operation, await deps.execute(operation, deps.owner));
    } catch (error) {
      // Admission may have committed even when notification or HTTP failed.
      const receipt = await deps.recover(operation);
      if (receipt) {
        await acknowledge(operation, receipt);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const reason =
        message.includes("owner") || message.includes("authority")
          ? "authority_changed"
          : message.includes("target") || message.includes("revision")
            ? "target_changed"
            : "admission_uncertain";
      await deps.client.request(
        "attention",
        {
          operationId: operation.id,
          payloadHash: operation.payloadHash,
          claimId: operation.claimId,
          reason,
        },
        attachment.epoch,
      );
    }
  }

  async function tick() {
    const startedGeneration = wakeGeneration;
    if (stopped) return;
    if (!(await deps.stillOwned())) {
      await revoke();
      return;
    }
    if (!attachment || Date.parse(attachment.leaseExpiresAt) <= Date.now()) {
      const result = await deps.client.request(
        "attach",
        {
          publicKey: deps.publicKey,
          reauthorizationGeneration: deps.reauthorizationGeneration ?? 0,
        },
        null,
      );
      await saveAttachment(z.object({ attachment: z.unknown() }).parse(result).attachment);
    }
    const renewed = await publishPonderDesktopCatalog({
      catalog: await deps.catalog(),
      client: deps.client,
      epoch: attachment!.epoch,
      stillOwned: async () => !stopped && (await deps.stillOwned()),
    });
    await saveAttachment(z.object({ attachment: z.unknown() }).parse(renewed).attachment);
    const knownIds = [...operations.keys()];
    for (let offset = 0; offset < knownIds.length; offset += 100) {
      const reconciled = z.object({ operations: z.array(z.object({ id: z.string(), payloadHash: z.string(),
        state: PonderDesktopOperationSchema.shape.state, error: z.string().optional(), updatedAt: z.string() })).max(100) })
        .parse(await deps.client.request("reconcile", { operationIds: knownIds.slice(offset, offset + 100) }, attachment!.epoch));
      for (const update of reconciled.operations) {
        const prior = operations.get(update.id);
        if (!prior || prior.payloadHash !== update.payloadHash) throw new Error("ponder_relay_operation_identity_changed");
        if (["completed", "failed", "cancelled", "expired"].includes(update.state)) operations.delete(update.id);
        else operations.set(update.id, PonderDesktopOperationSchema.parse({ ...prior, ...update }));
      }
    }
    for (const operation of [...operations.values()]) {
      if (stopped) return;
      try { await processOperation(operation); }
      catch (error) { deps.warn(`Ponder desktop operation ${operation.id}: ${String(error)}`); }
    }
    pollingNeeded = cloudObligations || operations.size > 0 || wakeGeneration !== startedGeneration;
  }

  function schedule(delay = PONDER_DESKTOP_RENEW_MS) {
    if (stopped || !pollingNeeded) return;
    timer = setTimeout(() => {
      timer = null;
      running = tick()
        .catch((error) => deps.warn(`Ponder desktop connection: ${String(error)}`))
        .finally(() => {
          running = null;
          schedule();
        });
    }, delay);
    timer.unref();
  }

  async function revoke() {
    stopped = true;
    if (timer) clearTimeout(timer);
    // Fence local admission first, including work already waiting in the serial queue.
    await deps.clearAuthority(deps.client.runtimeId);
    if (attachment)
      await deps.client
        .request("revoke", {}, attachment.epoch)
        .catch((error) => deps.warn(`Ponder desktop revocation: ${String(error)}`));
  }

  return {
    receiveOperations(payload: unknown, hasObligations: boolean) {
      cloudObligations = hasObligations;
      const received = z.array(PonderDesktopOperationSchema).max(100).parse(payload);
      for (const operation of received) {
        if (!Object.entries(deps.client.scope).every(([key, value]) => operation.origin.scope[key as keyof typeof operation.origin.scope] === value)) throw new Error("ponder_relay_operation_scope_changed");
        if (!operations.has(operation.id) && operations.size >= 1000) throw new Error("ponder_relay_operation_limit");
        const prior = operations.get(operation.id);
        if (prior && prior.payloadHash !== operation.payloadHash) throw new Error("ponder_relay_operation_identity_changed");
        if (["completed", "failed", "cancelled", "expired"].includes(operation.state)) operations.delete(operation.id);
        else operations.set(operation.id, operation);
      }
      wakeGeneration++; pollingNeeded = hasObligations || operations.size > 0;
      if (pollingNeeded && !running) { if (timer) clearTimeout(timer); timer = null; schedule(0); }
    },
    needsConnection: () => pollingNeeded || operations.size > 0,
    relayAuthority(deviceId: string, genericRuntimeId: string) {
      if (!attachment || stopped || Date.parse(attachment.leaseExpiresAt) <= Date.now()) return null;
      const payload = { deviceId, genericRuntimeId };
      return { proof: deps.client.proof("/ponder/desktop/relay-ticket", payload, attachment.epoch), payload };
    },
    wake() {
      if (stopped) return;
      wakeGeneration++;
      pollingNeeded = true;
      if (!running && !timer) schedule();
    },
    async refresh() {
      if (stopped) throw new Error("ponder_desktop_connection_unavailable");
      pollingNeeded = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await running?.catch(() => undefined);
      if (stopped) throw new Error("ponder_desktop_connection_unavailable");
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      running = tick().finally(() => {
        running = null;
        schedule();
      });
      await running;
    },
    async start() {
      if (running || timer || stopped) return;
      running = tick().finally(() => {
        running = null;
        schedule();
      });
      await running;
    },
    async close() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await deps.clearAuthority(deps.client.runtimeId);
      await running?.catch(() => undefined);
    },
    revoke,
    status: () => ({
      state: stopped
        ? "unlinked"
        : attachment && !pollingNeeded
          ? "idle"
          : attachment && Date.parse(attachment.leaseExpiresAt) > Date.now()
            ? "online"
            : "offline",
      authorizationRevision: attachment?.authorizationRevision ?? null,
      scope: deps.client.scope,
      leaseExpiresAt: attachment?.leaseExpiresAt ?? null,
    }),
    proofForHumanTurn(path: string, body: Record<string, unknown>, idempotencyKey: string | null) {
      if (stopped || !attachment || Date.parse(attachment.leaseExpiresAt) <= Date.now())
        return null;
      return deps.client.proof(path, { body, idempotencyKey }, attachment.epoch);
    },
  };
}
