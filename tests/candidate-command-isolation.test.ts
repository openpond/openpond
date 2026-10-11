import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, test } from "vitest";
import { createCandidateCommandExecutor } from "../apps/server/src/harness/experiment-candidate-command.js";

import { contentHash } from "@openpond/harness";
import { buildTaskset, computeTasksetHash } from "@openpond/taskset-sdk";
import { prepareAuthoredTasksetSource } from "openpond-sdk/taskset-packages";
import { attemptFixture, tasksetFixture, withTrainingStore } from "./helpers/training-fixtures.js";
import { createTaskEvaluationService } from "../apps/server/src/training/evaluation-service.js";
import { persistBinaryTaskAttemptArtifact } from "../apps/server/src/training/task-attempt-artifact-service.js";
import { tasksetPackageDirectoryId } from "../apps/server/src/training/taskset-package-path.js";

// Failure story: normal command/Agent tooling can escape a changed cwd and modify the live Profile.
it("confines real shell processes to the candidate, with fresh revision authorization and bounded output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "candidate-isolation-")), candidate = await mkdtemp(path.join(root, "candidate-")), live = path.join(root, "live-owner.txt");
  await writeFile(live, "live owner source"); let revision = 1, admissions = 0;
  const execute = createCandidateCommandExecutor({ authorize: async input => {
    admissions++; if (input.expectedRevision !== revision) throw new Error("stale candidate");
    return { candidateId: "candidate", candidateRevision: revision, ownerId: "owner", sessionId: "session", turnId: "turn", sourceRoot: candidate, writablePaths: ["."] };
  } });
  const identity = { candidateId: "candidate", sessionId: "session", turnId: "turn", expectedRevision: 1 };
  try {
    const result = await execute({ ...identity, command: `printf candidate > changed.txt; if cat '${live}'; then exit 31; fi; if printf tampered > '${live}'; then exit 32; fi; /runtime/node -e 'process.stdout.write("sdk runtime available")'` });
    expect(result.code).toBe(0); expect(result.stdout).toContain("sdk runtime available");
    expect(await readFile(path.join(candidate, "changed.txt"), "utf8")).toBe("candidate"); expect(await readFile(live, "utf8")).toBe("live owner source");
    const capped = await execute({ ...identity, command: "/runtime/node -e 'process.stdout.write(\"x\".repeat(1000))'", maxOutputBytes: 20 });
    expect(capped.stdout).toHaveLength(20); expect(capped.stdoutTruncated).toBe(true);
    revision = 2; await expect(execute({ ...identity, command: "true" })).rejects.toThrow("stale candidate");
    expect(admissions).toBe(3);
    await expect(execute({ ...identity, expectedRevision: 2, cwd: root, command: "true" })).rejects.toThrow("escapes");
  } finally { await rm(root, { recursive: true, force: true }); }
});

// A published process grader must qualify real private bytes, keep fixture
  // scope separate, deny host files, and reject claimed or changed outputs.
  test("grades immutable process fixtures and owner-recorded output bytes", async () => withTrainingStore(async ({ store, directory }) => {
    const modulePath = "graders/private.mjs", fixturePath = "fixtures/result.bin";
    const fixtureId = `taskset-file-${contentHash(fixturePath)}`;
    const source = `import fs from 'node:fs'; export function verify({artifacts}) { let denied=false; try { fs.readFileSync(${JSON.stringify(path.join(directory, "state/state.sqlite"))}); } catch { denied=true; } const passed=denied && artifacts.length===1 && Buffer.from(artifacts[0].base64,'base64').toString()==='verified bytes'; return {score:Number(passed),passed,feedback:'Checked pinned bytes with filesystem isolation',evidenceRefs:[]}; }`;
    const custom = { id: "private", version: "1", label: "Private artifact", kind: "custom_verifier" as const, runtime: "sandbox_process" as const,
      module: modulePath, exportName: "verify", timeoutMs: 10000, networkPolicy: "none" as const, weight: 1, hardGate: true, rewardEligible: true, privileged: true, metadata: {} };
    const text = { id: "text", version: "1", label: "Text", kind: "state" as const, weight: 0, hardGate: true, rewardEligible: false, privileged: true, config: { fields: ["text"] }, metadata: {} };
    const initial = tasksetFixture({ graders: [custom, text] });
    initial.tasks = initial.tasks.map(task => ({ ...task, privilegedContextRef: null }));
    initial.environment.metadata.runtimeSourceTasksetId = initial.id;
    initial.graderFixtures = [true, false].map(good => ({ id: good ? "private-good" : "private-missing", taskId: "task_eval", label: good ? "positive" : "negative",
      output: { text: "irrelevant" }, infrastructureError: null, expectedPassed: good, expectedRewardEligible: true,
      metadata: { graderIds: [custom.id], artifactAssetIds: good ? [fixtureId] : [] } }));
    initial.graderFixtures.push({ id: "text-good", taskId: "task_eval", label: "positive", output: { text: "Goodbye friend" }, infrastructureError: null,
      expectedPassed: true, expectedRewardEligible: false, metadata: { graderIds: [text.id], expectedScore: 1 } });
    const files = new Map([[modulePath, Buffer.from(source)], [fixturePath, Buffer.from("verified bytes")]]);
    const { taskset } = prepareAuthoredTasksetSource(initial, files, "openpond.desktop.v1");
    const inventory = taskset.metadata.portableFileInventory as { asset: Record<string, unknown>; sourcePath: string }[];
    const verifierFile = inventory.find(file => file.sourcePath === modulePath)!;
    inventory.push({ asset: { ...verifierFile.asset, id: "same-byte-private-alias" }, sourcePath: modulePath });
    taskset.contentHash = computeTasksetHash(taskset);
    const root = path.join(directory, "training/tasksets", tasksetPackageDirectoryId(taskset));
    for (const [relative, bytes] of files) { await mkdir(path.dirname(path.join(root, relative)), { recursive: true }); await writeFile(path.join(root, relative), bytes); }
    await buildTaskset(taskset, root);
    await store.upsertTaskset(taskset);
    const selected = { id: taskset.id, revision: taskset.revision, contentHash: taskset.contentHash };
    const service = createTaskEvaluationService({ store, storeDir: directory });
    const audit = await service.auditFixtures({ tasksetId: taskset.id, tasksetRef: selected });
    expect(audit.report).toMatchObject({ passed: true, fixtureRefs: ["private-good", "private-missing", "text-good"] });
    expect(audit.results.map(item => item.result.components.map(component => component.graderId))).toEqual([["private"], ["private"], ["text"]]);
    const attempt = attemptFixture({ metadata: { fixtureLabel: "positive", fixtureId: "private-good" } });
    const grade = async () => service.grade({ tasksetId: taskset.id, tasksetRef: selected, taskId: "task_eval", attempt });
    expect(await grade()).toMatchObject({ passed: false, components: [{ graderId: "private", score: 0 }, { graderId: "text", score: 1 }] });
    const artifact = await persistBinaryTaskAttemptArtifact({ store, storeDir: directory, tasksetId: taskset.id, taskId: "task_eval", attemptId: attempt.id,
      requestId: "owned-output", kind: "output_artifact", bytes: Buffer.from("verified bytes"), mediaType: "application/octet-stream", fileLabel: "result", extension: "bin", timestamp: () => new Date().toISOString() });
    attempt.artifactRefs = [artifact.id];
    expect(await grade()).toMatchObject({ passed: true, score: 1 });
    await writeFile(artifact.path, "tampered bytes");
    expect(await grade()).toMatchObject({ passed: false, score: null, rewardEligible: false, failureClass: "grader_failure" });
    await writeFile(path.join(root, modulePath), "export const verify = () => ({ score: 1, passed: true, feedback: 'forged' });");
    await expect(service.auditFixtures({ tasksetId: taskset.id, tasksetRef: selected })).rejects.toThrow("immutable");
  }));
