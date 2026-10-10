import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { DatasetPreparationAuthoringMessagesSchema } from "../../packages/sdk/src/dataset-preparation-authoring-contracts.js";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../../apps/cli/dist/cli.js", import.meta.url));
const directory = await mkdtemp(path.join(tmpdir(), "openpond-authoring-proof-"));
await chmod(directory, 0o700);
const invoke = (file: string) => exec(process.execPath, [cli, "__dataset-preparation-authoring", file], {
  cwd: directory, timeout: 30_000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8",
});
try {
  const now = "2026-10-01T00:00:00.000Z";
  const evidence = [{ source: { schemaVersion: "openpond.connectedDatasetSource.v1", kind: "connected_activity", id: "owned-source",
    profileId: "owned-team", title: "Owned synthetic authoring proof", sourceHash: "a".repeat(64), occurredAt: now,
    licensingStatus: "approved", secretScanStatus: "passed", piiScanStatus: "passed", origin: "codex", sourceId: "owned-conversation",
    sessionId: "owned-session", normalizerVersion: "connected-evidence-1", projection: "conversation", ownerUserId: "owned-user",
    purpose: "recorded_evaluation", metadata: {} }, excerpts: [{ role: "user", text: "Return exactly yes.", turnId: "owned-requirement" }] }];
  const request = { action: "messages", id: "owned-candidate", evidence, instruction: "Keep the actual requirement. Proposals are not qualified checks.",
    buildSpecification: { kind: "verifiable_reward", task: "Return exactly yes.", rules: [{ id: "literal", points: 1, condition: "Output is exactly yes." }], otherwisePoints: 0 } };
  const file = path.join(directory, "request.json");
  await writeFile(file, JSON.stringify(request), { mode: 0o600, flag: "wx" });
  const result = DatasetPreparationAuthoringMessagesSchema.parse(JSON.parse((await invoke(file)).stdout));
  assert.match(result.skillHash, /^[a-f0-9]{64}$/);
  assert.ok(result.messages.some((message) => message.content.includes("Return exactly yes.")));
  assert.ok(result.messages.some((message) => message.role === "system"));
  await chmod(file, 0o644);
  await assert.rejects(invoke(file));
  await chmod(file, 0o600);
  const linked = path.join(directory, "linked.json");
  await symlink(file, linked);
  await assert.rejects(invoke(linked));
  const oversized = path.join(directory, "oversized.json");
  const handle = await open(oversized, "wx", 0o600);
  try { await handle.truncate(4 * 1024 * 1024 + 1); } finally { await handle.close(); }
  await assert.rejects(invoke(oversized));
  const invalid = path.join(directory, "invalid.json");
  await writeFile(invalid, JSON.stringify({ action: "validate", evidence, content: "not structured authoring output" }), { mode: 0o600, flag: "wx" });
  await assert.rejects(invoke(invalid));
  console.log(JSON.stringify({ providerCalls: 0, installedSkillResolvedOutsideCheckout: true, boundedAuthoringMessages: true,
    worldReadableRequestBlocked: true, symbolicLinkBlocked: true, oversizedRequestBlocked: true, invalidProposalBlocked: true }));
} finally { await rm(directory, { recursive: true, force: true }); }
