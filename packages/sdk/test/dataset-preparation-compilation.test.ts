import { expect, it } from "vitest";
import { gradeTaskEvidence, verifyTaskGrade } from "@openpond/evals/graders";
import { createRewardRelease, createRewardBinding, compileBoundGraders, executeRewardBinding, composeBoundRewards } from "@openpond/evals/rewards";
import { contentHash, sha256 } from "@openpond/harness";
import { createPreparedTaskAuthoringWorkspace, assemblePreparedTaskWorkspaces, compileTasksetDraftWorkspace, preparedRepositoryEnvironment } from "../src/dataset-workspaces.js";
import { createTasksetDraft, createTasksetDraftWorkspace, TaskDesignProposalSchema, ConnectedDatasetSourceRefSchema } from "../src/taskset-drafts.js";
import { prepareImportedTasksetPackage } from "../src/taskset-packages.js";

// An authorer's replacement prompt/answer must never cross the preparation
// boundary into an evaluated policy's input or become independent ground truth.
it("compiles the retained input without admitting authored witnesses or changed starting state", async () => {
  const now = "2026-10-01T00:00:00.000Z";
  const source = ConnectedDatasetSourceRefSchema.parse({ schemaVersion: "openpond.connectedDatasetSource.v1", kind: "connected_activity",
    id: "conversation", profileId: "team", title: "Owned synthetic compilation evidence", sourceHash: "a".repeat(64), occurredAt: now,
    licensingStatus: "approved", secretScanStatus: "passed", piiScanStatus: "passed", origin: "codex", sourceId: "conversation", sessionId: "session",
    normalizerVersion: "connected-evidence-1", projection: "conversation", ownerUserId: "owner", purpose: "recorded_evaluation", metadata: {} });
  const initialInput = { messages: [{ role: "user", content: "Return exactly yes." }] };
  const initialEnvironment = createTasksetDraft({ profileId: "team", id: "environment", now }).environment;
  const provenance = { schemaVersion: "openpond.preparedTaskProvenance.v1" as const, candidateId: "candidate", preparationId: "preparation", familyKey: "family",
    sourceSpans: [{ source: { id: "conversation", snapshotHash: source.sourceHash, boundaryId: "boundary", boundaryRevisionHash: "b".repeat(64) }, startSequence: 0, endSequence: 0, role: "requirement" as const }],
    firstAvailableAt: now, initialInputHash: contentHash(initialInput), initialEnvironmentHash: contentHash(initialEnvironment), initialAssetsHash: null, sourceScopeHash: "c".repeat(64) };
  const proposal = TaskDesignProposalSchema.parse({ schemaVersion: "openpond.taskDesignProposal.v1", id: "proposal", name: "Exact literal",
    objective: "Return the requested literal", taskKind: "chat", sourceIds: [source.id], assumptions: [], successCriteria: ["Return exactly yes."],
    proposedGraders: [{ id: "literal", version: "1", label: "Required literal", kind: "content", config: { operator: "exact_equals", expectedValue: "yes" },
      weight: 1, hardGate: true, rewardEligible: true, privileged: false, metadata: {} }],
    graderFixtures: [{ id: "good", taskIndex: 0, label: "positive", output: { text: "yes" }, infrastructureError: null, expectedPassed: true, expectedRewardEligible: true },
      { id: "bad", taskIndex: 0, label: "negative", output: { text: "no" }, infrastructureError: null, expectedPassed: false, expectedRewardEligible: false }],
    proposedExamples: [{ id: "example", sourceId: source.id, sourceTurnId: null, split: "train", origin: "expert_authored",
      inputPrompt: "UNTRUSTED AUTHOR REPLACEMENT", expectedOutputText: "UNTRUSTED HISTORICAL ANSWER", rationale: "Synthetic proposed witness" }],
    proposedMethod: "grpo", policy: { policyVisibleFields: ["expectedOutput"], privilegedFields: [] }, createdAt: now });
  const input = { teamId: "team", provenance, initialInput, initialEnvironment, proposal, sources: [source], skillHash: "d".repeat(64), modelId: "researcher", attempt: 1, createdAt: now };
  const workspace = createPreparedTaskAuthoringWorkspace(input);
  const compiled = compileTasksetDraftWorkspace({ workspace, preparation: null, adapterId: "preparation-compilation-proof", now });
  expect(compiled.taskset.tasks[0]!.input).toEqual(initialInput);
  expect(compiled.taskset.tasks[0]!.expectedOutput).toBeNull();
  expect(compiled.taskset.tasks[0]!.split).toBe("validation");
  expect(compiled.taskset.policy.policyVisibleFields).toEqual(["input"]);
  expect(compiled.taskset.graders.every((grader) => grader.privileged)).toBe(true);
  expect(JSON.stringify(compiled)).not.toContain("UNTRUSTED AUTHOR REPLACEMENT");
  expect(JSON.stringify(compiled)).not.toContain("UNTRUSTED HISTORICAL ANSWER");
  expect(workspace.draft.graderFixtures.every((fixture) => fixture.metadata.independentlyQualified === false)).toBe(true);
  expect(() => createPreparedTaskAuthoringWorkspace({ ...input, initialInput: { prompt: "Changed" } })).toThrow(/reconstruction/);
  expect(() => createPreparedTaskAuthoringWorkspace({ ...input, initialEnvironment: { ...initialEnvironment, stateful: true } })).toThrow(/reconstruction/);
  expect(() => createPreparedTaskAuthoringWorkspace({ ...input, proposal: { ...proposal, proposedExamples: [proposal.proposedExamples[0]!, proposal.proposedExamples[0]!] } })).toThrow(/exactly one/);
  expect(() => createPreparedTaskAuthoringWorkspace({ ...input, proposal: { ...proposal, graderFixtures: proposal.graderFixtures.map((fixture) => ({ ...fixture, metadata: { substituteExpectedOutput: true } })) } })).toThrow(/historical answer/);

  // A combined version must score each task with its declared checks, while
  // retaining the entire final grader-set hash against selective omission.
  const secondInput = { messages: [{ role: "user", content: "Return exactly no." }] };
  const second = createPreparedTaskAuthoringWorkspace({ ...input, initialInput: secondInput,
    provenance: { ...provenance, candidateId: "candidate-2", familyKey: "family-2", initialInputHash: contentHash(secondInput) },
    proposal: { ...proposal, proposedGraders: proposal.proposedGraders.map(grader => grader.kind === "content"
      ? { ...grader, config: { operator: "exact_equals", expectedValue: "no" } } : grader) } });
  const base = createTasksetDraftWorkspace({ schemaVersion: "openpond.tasksetDraftWorkspace.v1", files: [],
    draft: createTasksetDraft({ profileId: "team", id: "destination", now }) });
  const assembled = assemblePreparedTaskWorkspaces({ base, candidates: [workspace, second], preparationId: "preparation", revision: 2, now });
  const final = compileTasksetDraftWorkspace({ workspace: assembled, preparation: null, adapterId: "preparation-compilation-proof", now });
  expect(final.taskset.tasks.map(task => task.input)).toEqual([initialInput, secondInput]);
  expect(final.taskset.graders.map(grader => grader.taskIds)).toEqual([["candidate"], ["candidate-2"]]);
  const rewards = final.taskset.graders.map(grader => {
    const { id, version: _version, taskIds: _scope, weight: _weight, hardGate: _gate, rewardEligible: _eligible, privileged: _private, ...implementation } = grader;
    return createRewardRelease({ schemaVersion: "openpond.rewardRelease.v1", id, revision: 1, name: id, description: "",
      implementation, rawScore: { minimum: 0, maximum: 1 }, assets: [] });
  });
  const binding = createRewardBinding({ schemaVersion: "openpond.rewardBinding.v1", id: "scoped-prepared-rewards", revision: 1,
    sources: rewards.map((reward, index) => ({ graderId: reward.id, taskIds: final.taskset.graders[index]!.taskIds,
      reward: { id: reward.id, revision: reward.revision, contentHash: reward.contentHash }, role: "training",
      normalization: { kind: "identity" }, weight: 1, required: true, hardGate: true, privileged: true, fixtureRefs: [] })),
    aggregation: "weighted_mean", unscorable: "exclude_optional_require_all_required" }, rewards);
  expect(compileBoundGraders(binding, rewards).map(grader => grader.taskIds)).toEqual([["candidate"], ["candidate-2"]]);
  for (const [index, expected] of ["yes", "no"].entries()) {
    const task = final.taskset.tasks[index]!;
    const evidence = { output: { text: expected }, artifactRefs: [], runtimeEventRefs: [] };
    const grade = await gradeTaskEvidence({ task, evidence, graders: final.taskset.graders });
    expect(grade).toMatchObject({ score: 1, passed: true, rewardEligible: true });
    expect(grade.components).toHaveLength(1);
    expect(verifyTaskGrade(grade, { task, evidence, graders: final.taskset.graders })).toEqual(grade);
    expect(() => verifyTaskGrade(grade, { task, evidence, graders: final.taskset.graders.filter(grader => grader.taskIds?.includes(task.id)) })).toThrow(/graders/);
    const wrong = await gradeTaskEvidence({ task, evidence: { ...evidence, output: { text: expected === "yes" ? "no" : "yes" } }, graders: final.taskset.graders });
    expect(wrong).toMatchObject({ score: 0, passed: false });
    const composition = await executeRewardBinding({ binding, rewards, task, evidence });
    expect(composition.training).toMatchObject({ status: "scored", score: 1, passed: true });
    expect(composition.results.filter(result => result.status === "not_applicable")).toHaveLength(1);
    expect(composeBoundRewards({ ...composition, binding })).toEqual(composition);
    expect(() => composeBoundRewards({ ...composition, binding, taskId: undefined })).toThrow(/scope_missing/);
    expect(() => composeBoundRewards({ ...composition, binding, results: composition.results.map(result => ({ ...result, status: "not_applicable" })) })).toThrow(/scope_mismatch/);
    expect((await executeRewardBinding({ binding, rewards, task, evidence: { ...evidence, output: { text: expected === "yes" ? "no" : "yes" } } })).training).toMatchObject({ score: 0, passed: false });
  }
  expect(() => assemblePreparedTaskWorkspaces({ base, candidates: [workspace, workspace], preparationId: "preparation", revision: 2, now })).toThrow(/repeats/);
  expect(() => assemblePreparedTaskWorkspaces({ base, candidates: [workspace, second], preparationId: "another-run", revision: 2, now })).toThrow(/another run/);

  // The same publication boundary must keep immutable repository files public
  // and authored checkers private; accepting altered starting bytes would grade
  // a different task even with an unchanged original request.
  const contents = new TextEncoder().encode("export const answer = false;\n");
  const asset = { path: "src/answer.ts", commitHash: "a".repeat(40), gitObjectHash: "b".repeat(40),
    mode: "100644" as const, sizeBytes: contents.length, sha256: sha256(contents),
    receiptId: `starting-assets-${"a".repeat(40)}`, receiptHash: "e".repeat(64), source: provenance.sourceSpans[0]!.source };
  const startingAssets = { schemaVersion: "openpond.preparedRepositoryStartingState.v1" as const, dependencyClosureQualified: false as const, assets: [asset] };
  const workEnvironment = preparedRepositoryEnvironment();
  const startingFiles = [{ path: "assets/starting-state/src/answer.ts", contentHash: asset.sha256, sizeBytes: contents.length, base64: Buffer.from(contents).toString("base64") }];
  const workInput = { ...input, initialEnvironment: workEnvironment, startingFiles, startingAssets,
    provenance: { ...provenance, initialEnvironmentHash: contentHash(workEnvironment), initialAssetsHash: contentHash(startingAssets) },
    proposal: { ...proposal, taskKind: "single_agent" as const,
      generatedFiles: [{ path: "graders/private-check.mjs", role: "verifier" as const, content: "export const privileged = true;\n" }] } };
  const workWorkspace = createPreparedTaskAuthoringWorkspace(workInput);
  const workPackage = compileTasksetDraftWorkspace({ workspace: workWorkspace, preparation: null, adapterId: "preparation-compilation-proof", now });
  expect(workPackage.taskset.environment.kind).toBe("work");
  expect(workPackage.taskset.tasks[0]!.input).toEqual(initialInput);
  expect(workPackage.taskset.tasks[0]!.requiredOutputs?.[0]?.path).toBe("changes.patch");
  expect(workWorkspace.draft.tasks[0]!.assets?.[0]?.stagingPath).toBe("starting-state/src/answer.ts");
  expect(workPackage.files.find(file => file.asset.path === "assets/candidate/starting-state/src/answer.ts")?.asset).toMatchObject({ contentHash: asset.sha256, visibility: "policy" });
  expect(workPackage.files.find(file => file.asset.path === "graders/private-check.mjs")?.asset.visibility).toBe("host_private");
  const imported = prepareImportedTasksetPackage({ package: workPackage, profileId: "team", name: "Retained repository", createdAt: now });
  expect(imported.taskset.tasks[0]!.assets?.[0]?.stagingPath).toBe("starting-state/src/answer.ts");
  expect(() => createPreparedTaskAuthoringWorkspace({ ...workInput, startingFiles: [{ ...startingFiles[0]!, base64: Buffer.from("changed").toString("base64") }] })).toThrow();
  expect(() => createPreparedTaskAuthoringWorkspace({ ...workInput, startingFiles: [] })).toThrow(/inventory/);
  expect(() => createPreparedTaskAuthoringWorkspace({ ...workInput, proposal: { ...workInput.proposal,
    generatedFiles: [{ path: startingFiles[0]!.path, role: "verifier", content: "replacement" }] } })).toThrow(/starting files/);
  const expandedNetwork = { ...workEnvironment, networkPolicy: "declared_scoped" as const };
  expect(() => createPreparedTaskAuthoringWorkspace({ ...workInput, initialEnvironment: expandedNetwork,
    provenance: { ...workInput.provenance, initialEnvironmentHash: contentHash(expandedNetwork) } })).toThrow(/fixed isolated Work/);
});
