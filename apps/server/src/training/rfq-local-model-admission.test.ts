import assert from "node:assert/strict";
import test from "node:test";

import { createRfqLocalModelAdmissionGate, type RfqLocalBudgetAuthority } from "./rfq-local-model-admission.js";

const pricing = { metadata: { billing: { pricing: {
  version: "test-revision", source: "fireworks-serverless",
  effectiveAt: "2026-09-27T00:00:00.000Z",
  inputUsdPerMillionTokens: 0.22,
  cachedInputUsdPerMillionTokens: 0.007,
  outputUsdPerMillionTokens: 0.66,
} } } };

function authority(cap = 25) {
  let committed = 0;
  const rows = new Map<string, { hash: string; cents: number; dispatched: boolean; released: boolean }>();
  const ledger: RfqLocalBudgetAuthority = {
    async reserve({ allocationId, requestHash, maximumCents }) {
      const existing = rows.get(allocationId);
      if (existing) {
        if (existing.hash !== requestHash || existing.cents !== maximumCents) throw new Error("identity conflict");
        return;
      }
      if (committed + maximumCents > cap) throw new Error("aggregate RFQ budget exceeded");
      rows.set(allocationId, { hash: requestHash, cents: maximumCents, dispatched: false, released: false });
      committed += maximumCents;
    },
    async markDispatched(id) {
      const row = rows.get(id);
      if (!row || row.released) throw new Error("reservation unavailable");
      row.dispatched = true;
    },
    async releaseBeforeDispatch(id) {
      const row = rows.get(id);
      if (!row || row.dispatched) throw new Error("dispatched reservation cannot be released");
      if (!row.released) committed -= row.cents;
      row.released = true;
    },
  };
  return { ledger, committed: () => committed };
}

function request(requestId: string) {
  return { experimentId: "rfq-2026", requestId, provider: "openpond", model: "test-model",
    modelCatalogRaw: pricing, maximumInputTokens: 100_000, maximumOutputTokens: 2_000,
    providerEnforcesTokenCeilings: true };
}

test("RFQ admission fails closed on missing price, token proof, or aggregate capacity", async () => {
  const storage = authority(4);
  const gate = createRfqLocalModelAdmissionGate({ enabled: true, authority: storage.ledger });
  await assert.rejects(gate.admit({ ...request("missing-price"), modelCatalogRaw: null }), /verified price/);
  await assert.rejects(gate.admit({ ...request("unbounded"), providerEnforcesTokenCeilings: false }), /token ceilings/);
  const first = await gate.admit(request("round-1"));
  assert.equal(first.quote.maximumCents, 4);
  await first.dispatch();
  await assert.rejects(first.releaseBeforeDispatch(), /remain committed/);
  await assert.rejects(gate.admit(request("round-2")), /aggregate RFQ budget exceeded/);
  assert.equal(storage.committed(), 4);
});

test("only an undispatched request can release capacity", async () => {
  const storage = authority(4);
  const gate = createRfqLocalModelAdmissionGate({ enabled: true, authority: storage.ledger });
  const first = await gate.admit(request("round-1"));
  await first.releaseBeforeDispatch();
  assert.equal(storage.committed(), 0);
  await assert.rejects(first.dispatch(), /released before dispatch/);
  await gate.admit(request("round-2"));
  assert.equal(storage.committed(), 4);
});
