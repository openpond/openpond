import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  PONDER_DESKTOP_RENEW_MS, PonderDesktopOperationSchema, PonderDesktopInspectionSchema,
  type PonderDesktopAttachment,
} from "@openpond/contracts";
import { createPonderDesktopRuntime } from "./ponder-desktop-runtime.js";
import type { createPonderDesktopClient } from "./ponder-desktop-client.js";

// A pushed obligation racing with renewal must keep the shared request socket alive,
// and an idle caller must not continue its retired polling exchange.
it("suspends settled exchange and preserves pushed obligations racing with authority renewal", async () => {
  vi.useFakeTimers();
  const scope = {
    installationId: randomUUID(),
    profileId: "profile",
    ownerUserId: "owner",
    teamId: "team",
    bindingId: "binding",
    bindingRevision: 1,
  };
  const runtimeId = randomUUID();
  let epoch = randomUUID();
  let renewals = 0;
  let attaches = 0;
  let releaseRenew: (() => void) | null = null;
  let pauseNextRenew = false;
  const client: ReturnType<typeof createPonderDesktopClient> = {
    scope,
    runtimeId,
    proof: () => {
      throw new Error("unused");
    },
    async request(action) {
      const attachment: PonderDesktopAttachment = {
        scope,
        runtimeId,
        publicKey: "key",
        epoch,
        authorizationRevision: 1,
        reauthorizationGeneration: 0,
        state: "attached",
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        catalog: null,
      };
      if (action === "attach") {
        attaches++;
        epoch = randomUUID();
        return { attachment: { ...attachment, epoch } };
      }
      if (action === "renew") {
        renewals++;
        if (pauseNextRenew) {
          pauseNextRenew = false;
          await new Promise<void>(resolve => { releaseRenew = resolve; });
        }
        return { attachment };
      }
      throw new Error(`Unexpected ${action}`);
    },
  };
  const runtime = createPonderDesktopRuntime({
    client,
    publicKey: "key",
    owner: {
      version: 1,
      installationId: scope.installationId,
      profileId: scope.profileId,
      ownerUserId: scope.ownerUserId,
      teamId: scope.teamId,
      audience: "https://example.test",
    },
    catalog: async () => ({
      revision: "a".repeat(64),
      capturedAt: new Date().toISOString(),
      targets: [],
    }),
    stillOwned: async () => true,
    setAuthority: async () => {},
    clearAuthority: async () => {},
    recover: async () => null,
    reservation: async () => null,
    execute: async () => {
      throw new Error("No operation expected");
    },
    result: async () => null,
    inspection: async () => null,
    warn: (message) => {
      throw new Error(message);
    },
  });
  try {
    await runtime.start();
    expect(runtime.status().state).toBe("idle");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(renewals).toBe(1);
    runtime.receiveOperations([], true);
    await vi.advanceTimersByTimeAsync(0);
    expect(attaches).toBe(2);
    expect(runtime.status().state).toBe("online");
    await vi.advanceTimersByTimeAsync(PONDER_DESKTOP_RENEW_MS);
    expect(renewals).toBe(3);
    runtime.receiveOperations([], false);
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.status().state).toBe("idle");
    pauseNextRenew = true;
    const refreshing = runtime.refresh();
    await vi.waitFor(() => expect(releaseRenew).not.toBeNull());
    runtime.receiveOperations([], true);
    releaseRenew!();
    await refreshing;
    await vi.advanceTimersByTimeAsync(PONDER_DESKTOP_RENEW_MS);
    expect(renewals).toBe(5);
    expect(runtime.status().state).toBe("online");
  } finally {
    await runtime.close();
    vi.useRealTimers();
  }
});

// Reading SQLite may await pending writes. An account change during that read
// must fence publication, and running evidence must never use terminal-result delivery.
it("publishes running inspections separately and fences an owner change during capture", async () => {
  for (const changeOwnerDuringRead of [false, true]) {
    const scope = {
      installationId: randomUUID(), profileId: "profile", ownerUserId: "owner",
      teamId: "team", bindingId: "binding", bindingRevision: 1,
    };
    const runtimeId = randomUUID(), epoch = randomUUID(), now = new Date().toISOString();
    const attachment: PonderDesktopAttachment = {
      scope, runtimeId, epoch, publicKey: "key", authorizationRevision: 1,
      reauthorizationGeneration: 0, state: "attached", catalog: null,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const receipt = PonderDesktopOperationSchema.shape.receipt.unwrap().parse({
      sessionId: "local-task", sessionTitle: "Existing task",
      turnId: "running-turn", inputId: null, state: "inspected",
    });
    const operation = PonderDesktopOperationSchema.parse({
      id: "inspection-op", payloadHash: "a".repeat(64), state: "admitted",
      origin: { scope, epoch, originChatTurnId: "requesting-turn", originToolCallId: "read-call",
        authorizationRevision: 1 },
      intent: { action: "inspect", targetId: "local-task", targetRevision: "b".repeat(64),
        expectedTurnId: "running-turn" },
      target: { id: "local-task", kind: "session", title: "Existing task", providerId: "codex",
        modelId: null, experience: "work", workspaceId: "workspace", workspaceLabel: "Workspace",
        profileSelectionId: null, revision: "b".repeat(64), available: true,
        unavailableReason: null, canMessage: true, canSteer: true, canStop: true,
        activeTurnId: "running-turn" },
      claimId: randomUUID(), claimedEpoch: epoch, expiresAt: attachment.leaseExpiresAt,
      admittedAt: now, createdAt: now, updatedAt: now, receipt, error: null,
    });
    const inspection = PonderDesktopInspectionSchema.parse({
      operationId: operation.id, payloadHash: operation.payloadHash, sessionId: "local-task",
      sessionTitle: "Existing task", turnId: "running-turn", workspaceId: "workspace",
      providerId: "codex", modelId: null, capturedAt: now,
      taskStatus: "in_progress", taskCompletedAt: null, error: null, events: [],
      coverage: { olderEventsOmitted: false, textTruncated: false, textLimit: 16_000, eventLimit: 100 },
    });
    const published: unknown[] = [];
    let owns = true, terminalReads = 0;
    const client: ReturnType<typeof createPonderDesktopClient> = {
      scope, runtimeId, proof: () => { throw new Error("unused"); },
      async request(action, payload, requestedEpoch) {
        if (action === "attach" || action === "renew") return { attachment };
        if (action === "reconcile") return { operations: [{ id: operation.id, payloadHash: operation.payloadHash, state: operation.state, updatedAt: operation.updatedAt }] };
        if (action === "inspection") {
          expect(requestedEpoch).toBe(epoch);
          published.push(payload);
          return { created: true };
        }
        throw new Error(`Unexpected ${action}`);
      },
    };
    const runtime = createPonderDesktopRuntime({
      client, publicKey: "key", owner: { version: 1, installationId: scope.installationId,
        profileId: scope.profileId, ownerUserId: scope.ownerUserId, teamId: scope.teamId,
        audience: "https://example.test" },
      catalog: async () => ({ revision: "c".repeat(64), capturedAt: now, targets: [] }),
      stillOwned: async () => owns, setAuthority: async () => {}, clearAuthority: async () => {},
      recover: async () => receipt, reservation: async () => null,
      execute: async () => { throw new Error("An admitted inspection must not execute again"); },
      result: async () => { terminalReads++; return null; },
      inspection: async () => {
        await Promise.resolve();
        if (changeOwnerDuringRead) owns = false;
        return inspection;
      },
      warn: message => { throw new Error(message); },
    });
    try {
      await runtime.start();
      runtime.receiveOperations([operation], true);
      await runtime.refresh();
      expect(terminalReads).toBe(0);
      expect(published).toEqual(changeOwnerDuringRead ? [] : [inspection]);
    } finally {
      await runtime.close();
    }
  }
});
