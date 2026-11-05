import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { expect, it } from "vitest";
import { createRewardRelease } from "@openpond/evals/rewards";
import { canonicalSha256, createTrainingClient, OPENPOND_TRAINING_MEDIA_TYPE,
  parseAndVerifyModelModificationCapabilities, compileActivationForm, ExperimentDraftSaveSchema, trainingExperimentLearningSettings,
  type ExperimentDraftRecord, type ExperimentDraftReceipt, type ExperimentDraftSave, type ActivationExperimentFormDraft,
  type HostedEvaluationExperimentFormDraft } from "../src/training.js";

// Failure story: a successful save reply can still substitute another workspace,
// document or owner. Retries must retain their original receipt after later edits.
it("verifies standalone draft CRUD and retained receipts across real HTTP", async () => {
  let current: ExperimentDraftRecord | null = null, mutations = 0, mode = "valid";
  const receipts = new Map<string, ExperimentDraftReceipt>();
  let executionReply: unknown, executionPageReply: unknown;
  let compiledRequest: any;
  let modification: Record<string, any> | null = null, modificationPosts = 0;
  const modificationReceipts = new Map<string, any>();
  const server = createServer(async (request, response) => {
    const reply = (value: unknown, status = 200) => { response.writeHead(status, { "content-type": OPENPOND_TRAINING_MEDIA_TYPE }); response.end(JSON.stringify(value)); };
    try {
      const url = new URL(request.url!, "http://localhost");
      expect(request.headers.authorization).toBe("Bearer draft-fixture");
      if (request.method === "POST" && url.pathname.startsWith("/v1/training/modification-executions/")) {
        modificationPosts++;
        expect(request.headers["content-type"]).toBe(OPENPOND_TRAINING_MEDIA_TYPE);
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const input = JSON.parse(Buffer.concat(chunks).toString());
        if (url.pathname.endsWith("/compile")) {
          const content = {schemaVersion: "openpond.managedModificationCompilation.v1", teamId: input.teamId, actorId: "owner",
            projectId: input.projectId, method: input.method, query: input.query, formHash: await canonicalSha256(input.form),
            request: compiledRequest, inputHash: await canonicalSha256(compiledRequest)};
          if (mode === "compile-forged") content.formHash = "d".repeat(64);
          reply({...content, contentHash: await canonicalSha256(content)}); return;
        }
        let receipt = modificationReceipts.get(input.operationId);
        if (!receipt) {
          const preparing = url.pathname.endsWith("/prepare");
          if (preparing) modification = {id: `modification-${await canonicalSha256({teamId: input.teamId, ownerUserId: "owner", operationId: input.operationId})}`,
            teamId: input.teamId, ownerUserId: "owner", projectId: input.projectId, name: input.name, method: input.method,
            phase: "prepared", revision: 1, sourceContentHash: "a".repeat(64),
            plan: {contentHash: "b".repeat(64), inputHash: await canonicalSha256(input.request), runtimeHash: "c".repeat(64),
              maximumSpendUsd: input.maximumSpendUsd, createdAt: "2026-11-01T00:00:00Z", expiresAt: "2026-11-01T00:05:00Z"}, updatedAt: "2026-11-01T00:00:00Z"};
          else {
            expect(url.pathname).toBe(`/v1/training/modification-executions/${input.id}/${input.action}`);
            modification = {...modification!, phase: input.action === "start" ? "queued" : "cancelled", revision: input.expectedRevision + 1};
          }
          const content = {schemaVersion: "openpond.managedModificationExecutionReceipt.v1", operationId: input.operationId,
            requestHash: await canonicalSha256(preparing ? {action: "prepare", command: input} : input), execution: modification};
          receipt = {...content, contentHash: await canonicalSha256(content)};
          modificationReceipts.set(input.operationId, receipt);
        }
        if (mode === "modification-lost-ack") { request.socket.destroy(); return; }
        if (mode === "modification-forged") {
          const {contentHash: _hash, ...changed} = structuredClone(receipt); changed.execution.revision++;
          reply({...changed, contentHash: await canonicalSha256(changed)}); return;
        }
        reply(receipt); return;
      }
      if (url.pathname === "/v1/training/modification-executions") {
        expect(request.method).toBe("GET");
        expect(url.searchParams.get("teamId")).toBe("team");
        expect(url.searchParams.get("id")).toBe("execution-fixture");
        expect(url.searchParams.get("limit")).toBe("1");
        reply(executionPageReply); return;
      }
      if (url.pathname === "/v1/training/modification-executions/execution-fixture") {
        expect(request.method).toBe("GET");
        expect(url.searchParams.get("teamId")).toBe("team");
        reply(executionReply); return;
      }
      if (url.pathname === "/v1/training/modification-capabilities") {
        expect(request.method).toBe("GET");
        const query = Object.fromEntries(url.searchParams), checkedAt = new Date();
        if (mode === "capability-scope") query.revision = "another-model-revision";
        const methods = (["neuron_steering", "inspect_activations"] as const).map(method => ({ method,
          draftSchema: "openpond.experimentDraft.v1", validationLevel: null, execution: { state: "unavailable", code: "runtime_not_qualified", reason: "No qualified runtime." } }));
        if (mode === "capability-method") methods[1] = methods[0]!;
        if (mode === "capability-expired") checkedAt.setTime(checkedAt.getTime() - 600_000);
        const content = { schemaVersion: "openpond.modelModificationCapabilities.v1", teamId: "team", actorId: "owner",
          destination: "hosted", query, requestHash: await canonicalSha256(query), checkedAt: checkedAt.toISOString(),
          expiresAt: new Date(checkedAt.getTime() + 300_000).toISOString(), methods };
        reply({ ...content, contentHash: await canonicalSha256(content) }); return;
      }
      expect(url.pathname.startsWith("/v1/training/experiment-drafts")).toBe(true);
      if (request.method === "POST") {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const input = JSON.parse(Buffer.concat(chunks).toString());
        const archive = url.pathname.endsWith("/archive");
        const requestHash = await canonicalSha256(archive ? { id: "draft", ...input } : input);
        const prior = receipts.get(input.operationId);
        if (prior) { reply(prior); return; }
        if ((current?.revision ?? 0) !== input.expectedRevision) { reply({ code: "revision_conflict", message: "Newer saved draft." }, 409); return; }
        const content = { schemaVersion: "openpond.experimentDraftRecord.v1" as const, id: "draft", teamId: "team", ownerUserId: "owner",
          projectId: archive ? current!.projectId : input.projectId, draft: archive ? current!.draft : input.draft,
          revision: input.expectedRevision + 1, status: archive ? "archived" as const : "draft" as const,
          createdAt: "2026-10-31T00:00:00.000Z", updatedAt: "2026-10-31T00:00:00.000Z" };
        current = { ...content, contentHash: await canonicalSha256(content) }; mutations++;
        const receipt = { schemaVersion: "openpond.experimentDraftReceipt.v1" as const, operationId: input.operationId, requestHash, record: current };
        receipts.set(input.operationId, receipt); reply(receipt); return;
      }
      expect(url.searchParams.get("teamId")).toBe("team");
      let record = structuredClone(current!);
      if (mode === "hash") record.draft.name = "Substituted settings";
      if (mode === "owner") {
        const { contentHash: _hash, ...content } = { ...record, ownerUserId: "another-owner" };
        record = { ...content, contentHash: await canonicalSha256(content) };
      }
      if (mode === "trained-version" && record.draft.startingModel?.source === "trained") {
        record.draft.startingModel.trainedVersion.candidate.checkpointId = "substituted-checkpoint";
        const {contentHash: _hash, ...content} = record;
        record = {...content, contentHash: await canonicalSha256(content)};
      }
      reply(url.pathname.endsWith("/draft") ? record : { schemaVersion: "openpond.experimentDraftPage.v1", teamId: "team", ownerUserId: "owner",
        projectId: "project", items: [record], nextCursor: null });
    } catch (error) { reply({ code: "fixture_error", message: String(error) }, 500); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Expected HTTP listener.");
    const client = createTrainingClient({ baseUrl: `http://127.0.0.1:${address.port}`, headers: { authorization: "Bearer draft-fixture" } });
    // Saving native authoring text must not coerce incomplete controls, lose
    // fixture/grader pins or discard the snapshot when the action changes.
    const hostedEvaluationForm: HostedEvaluationExperimentFormDraft = {
      selectedDatasetId: "workspace", dataset: { kind: "workspace", id: "workspace", revision: 7, ownerUserId: "owner", taskIds: ["task-b"] },
      workspaceMode: "recorded", mode: "fixture", executionMode: "model_harness",
      name: "", modelId: "model", messages: [{ role: "user", content: "Retain\nthese instructions" }, { role: "assistant", content: "" }],
      temperature: "-", topP: ".", maxOutputTokens: "", budget: "", seedText: "0, ", reasoningEffort: "high", sourceId: "retained",
      harness: { harnessRelease: { id: "harness", contentHash: "b".repeat(64) }, agentSnapshot: { id: "agent", contentHash: "c".repeat(64) }, sourcePackageHash: "d".repeat(64) },
      project: { id: "project", revision: 4, contentHash: "e".repeat(64), targetId: "target" },
      members: [{ taskId: "task-b", fixtureId: "fixture-b" }], graderIds: [],
      graders: [{ id: "grader", version: "2", contentHash: "f".repeat(64), mappings: [{ destination: "input", path: ["answer"], source: "output", sourcePath: ["answer"] }] }],
      graderMappings: { grader: [] }, selectedGraders: [createRewardRelease({
        schemaVersion: "openpond.rewardRelease.v1", id: "grader", revision: 2, name: "Selected grader", description: "",
        implementation: { kind: "state", config: { fields: ["answer"] } }, rawScore: { minimum: 0, maximum: 1 }, assets: [],
      })],
      workflow: { repositoryId: "profile", sourceRevision: "pinned-revision", definitionId: "definition", workflowId: "workflow", label: "Workflow" },
      profile: { profileRepositoryId: "profile", sourceRevision: "pinned-revision", definitionId: "definition", sourceHash: "a".repeat(64),
        release: { id: "dataset", revision: 3, contentHash: "a".repeat(64) }, taskIds: ["task-b"] },
    };
    const input: ExperimentDraftSave = { schemaVersion: "openpond.experimentDraftSave.v1", teamId: "team", operationId: "create", expectedRevision: 0,
      projectId: "project", draft: { schemaVersion: "openpond.experimentDraft.v1", id: "draft", operationType: "evaluate", name: "Evaluation draft",
        startingModel: { source: "inference", label: "Fixture model", inferenceModelId: "model", baseModel: null },
        hostedEvaluationForm,
        evaluationForm: { form: { mode: "model", sourceId: "", profileChoiceId: "", name: "", modelId: "model",
          release: { id: "dataset", revision: 3, contentHash: "a".repeat(64) }, budget: null, outputTokens: null,
          temperature: null, prompt: "Retain these instructions", targetId: "model", seed: "0, 3", graderChoices: {} },
          selection: { release: { id: "dataset", revision: 3, contentHash: "a".repeat(64) }, mode: "subset", ids: ["task-b"] },
          source: null, executionLocation: "local" } } };
    const first = await client.saveExperimentDraft(input);
    expect(first.record.draft.evaluationForm).toEqual(input.draft.evaluationForm);
    expect(first.record.draft.startingModel).toEqual(input.draft.startingModel);
    expect(first.record.draft.hostedEvaluationForm).toEqual(hostedEvaluationForm);
    const edited = await client.saveExperimentDraft({ ...input, operationId: "edit", expectedRevision: 1, draft: { ...input.draft, name: "Edited" } });
    expect(edited.record.revision).toBe(2);
    expect(await client.saveExperimentDraft(input)).toEqual(first);
    expect((await client.getExperimentDraft("team", "draft")).draft.name).toBe("Edited");
    expect((await client.listExperimentDrafts("team", { projectId: "project", limit: 1 })).items).toEqual([edited.record]);
    mode = "hash";
    await expect(client.getExperimentDraft("team", "draft")).rejects.toMatchObject({ code: "experiment_draft_hash_mismatch" });
    mode = "owner";
    await expect(client.listExperimentDrafts("team", { projectId: "project" })).rejects.toMatchObject({ code: "experiment_draft_scope_mismatch" });
    mode = "valid";
    const archived = await client.archiveExperimentDraft("draft", { schemaVersion: "openpond.experimentDraftArchive.v1", teamId: "team", operationId: "archive", expectedRevision: 2 });
    expect(archived.record.status).toBe("archived");
    const restored = await client.saveExperimentDraft({ ...input, expectedRevision: 3, operationId: "restore" });
    expect(restored.record.status).toBe("draft");
    expect(restored.record.revision).toBe(4);
    const parent = { jobId: "source-job", artifact: { id: "source-artifact", contentHash: "b".repeat(64) }, checkpointId: "source-checkpoint", adapterMode: "shared" as const };
    const continued = await client.saveExperimentDraft({ ...input, operationId: "continue", expectedRevision: 4,
      draft: { schemaVersion: "openpond.experimentDraft.v1", id: "draft", operationType: "grpo", name: "Continued training",
        hostedEvaluationForm,
        trainingForm: { baseModel: null, recipe: { schemaVersion: "openpond.rftRecipe.v1", method: "grpo", parameterization: "lora" },
          batch: null, evaluation: null, validationSplit: "validation", name: "Continued training", budget: "", parent, gpuSelection: { mode: "manual", availabilityId: "reviewed-offer", gpuType: "reviewed-gpu", gpuCount: 2 },
          learningIntent: { enabled: false, mode: "nightly", minimumTasks: "2", localTime: "20:00", timeZone: "UTC", maximumSpendUsd: "1", maximumDailySpendUsd: "1", continuationAdapterMode: "sequential_merge" },
          startingModelLabel: "Model / Version 2" } } });
    const reopenedTraining = (await client.getExperimentDraft("team", "draft")).draft.trainingForm!;
    expect(reopenedTraining.parent).toEqual(parent);
    // A future scheduled mode survives draft transport independently of this
    // stage's parent mode, then reaches the saved Model configuration owner.
    expect(reopenedTraining.learningIntent?.continuationAdapterMode).toBe("sequential_merge");
    expect(trainingExperimentLearningSettings(reopenedTraining).continuationAdapterMode).toBe("sequential_merge");
    expect(await client.saveExperimentDraft(input)).toEqual(first);
    expect(continued.record.draft.trainingForm?.gpuSelection).toEqual({ mode: "manual", availabilityId: "reviewed-offer", gpuType: "reviewed-gpu", gpuCount: 2 });
    expect((await client.getExperimentDraft("team", "draft")).draft.hostedEvaluationForm).toEqual(hostedEvaluationForm);
    expect(continued.record.revision).toBe(5);
    // New authoring methods must survive the same transport/revision owner;
    // incomplete fields cannot become training requests or acquire a spend cap.
    const activationForm: ActivationExperimentFormDraft = { baseModel: null,
      prompts: [{ id: "prompt", text: "Retain\nthese exact instructions" }],
      coordinates: [{ id: "coordinate", layer: "", neuron: "17", dose: "-" }], doseMultipliers: "-1, 0, 1",
      normalization: { mode: "baseline_prompt_residual_median", statistic: "midpoint_median_fp32", sample: "non_padding_prompt_after_position_zero" },
      tokenScope: { phase: "decode_only", positions: "after_position_zero" }, maxNewTokens: "",
      maximumCapturedValues: "65536", maximumForwardTokenWork: "1000000", maximumDurationSeconds: "300" };
    for (const [index, operationType] of (["neuron_steering", "inspect_activations"] as const).entries()) {
      const draft = { schemaVersion: "openpond.experimentDraft.v1" as const, id: "draft", operationType, name: "Activation draft", activationForm };
      const command = { ...input, operationId: operationType, expectedRevision: 5 + index, draft };
      const receipt = await client.saveExperimentDraft(command);
      expect((await client.getExperimentDraft("team", "draft")).draft).toEqual(draft);
      expect(await client.saveExperimentDraft(command)).toEqual(receipt);
      await expect(client.saveExperimentDraft({ ...command, draft: { ...draft, training: {} } })).rejects.toThrow();
    }
    expect(mutations).toBe(7);
    const query = { teamId: "team", modelId: "example/model", source: "managed" as const, revision: "pinned-revision", tokenizerRevision: "pinned-tokenizer" };
    const capability = await client.modificationCapabilities(query);
    expect(capability.methods.every(row => row.execution.state === "unavailable")).toBe(true);
    await expect(parseAndVerifyModelModificationCapabilities(capability, query, "another-actor")).rejects.toMatchObject({ code: "model_modification_capability_mismatch" });
    for (const invalid of ["capability-scope", "capability-method", "capability-expired"]) {
      mode = invalid;
      await expect(client.modificationCapabilities(query)).rejects.toThrow();
    }
    expect(mutations).toBe(7);
    // A managed read must verify the full capture against its exact input;
    // receiving a capture does not turn a dispatching execution into completion.
    const document = JSON.parse(readFileSync(new URL("../fixtures/python-foundation/activation-reference-workflow.json", import.meta.url), "utf8"));
    const execution = {
      schemaVersion: "openpond.managedModificationExecution.v1", id: "execution-fixture", teamId: "team", ownerUserId: "owner", projectId: null,
      name: "Capture evidence", method: "neuron_steering", phase: "dispatching", revision: 3, sourceContentHash: "a".repeat(64),
      plan: { contentHash: "b".repeat(64), inputHash: await canonicalSha256(document.request), runtimeHash: "c".repeat(64),
        maximumSpendUsd: "2.000000", createdAt: "2026-11-01T00:00:00Z", expiresAt: "2026-11-01T00:05:00Z" },
      request: document.request, result: document.result, resultRecordedAt: "2026-11-01T00:01:00Z", updatedAt: "2026-11-01T00:01:00Z",
    };
    executionReply = { ...execution, contentHash: await canonicalSha256(execution) };
    expect((await client.getModificationExecution("team", "execution-fixture")).phase).toBe("dispatching");
    // Canonical history survives client journal loss, while a resealed page
    // cannot substitute another creator, filter, Project or execution identity.
    const {schemaVersion: _version, request: _request, result: _result, resultRecordedAt: _recorded, ...executionMetadata} = execution;
    const historyQuery = {id: "execution-fixture", method: "neuron_steering" as const, phase: "dispatching" as const, limit: 1};
    const page = {schemaVersion: "openpond.managedModificationExecutionPage.v1", teamId: "team", ownerUserId: "owner", query: historyQuery,
      items: [{...executionMetadata, plan: {...executionMetadata.plan, maximumSpendUsd: "2.000000"}, model: document.request.model}], nextCursor: null};
    executionPageReply = {...page, contentHash: await canonicalSha256(page)};
    expect((await client.listModificationExecutions("team", historyQuery, {ownerUserId: "owner"})).items[0]?.id).toBe("execution-fixture");
    for (const change of ["owner", "filter", "row", "hash"]) {
      const changed = structuredClone(page);
      if (change === "owner") { changed.ownerUserId = "another-owner"; changed.items[0]!.ownerUserId = "another-owner"; }
      if (change === "filter") changed.query.id = "substituted-execution";
      if (change === "row") changed.items[0]!.id = "substituted-execution";
      executionPageReply = {...changed, contentHash: change === "hash" ? "0".repeat(64) : await canonicalSha256(changed)};
      await expect(client.listModificationExecutions("team", historyQuery, {ownerUserId: "owner"})).rejects.toMatchObject({code: "managed_modification_history_mismatch"});
    }
    for (const change of ["id", "capture", "input", "method"]) {
      const changed = structuredClone(execution);
      if (change === "id") changed.id = "another-execution";
      if (change === "capture") changed.result.captures[0].after += 1;
      if (change === "input") changed.plan.inputHash = "d".repeat(64);
      if (change === "method") changed.method = "inspect_activations";
      executionReply = { ...changed, contentHash: await canonicalSha256(changed) };
      await expect(client.getModificationExecution("team", "execution-fixture")).rejects.toThrow();
    }
    expect(mutations).toBe(7);
    // Immutable mutation receipts survive later actions and a lost POST reply;
    // resealing another revision must not authorize an accepted Start response.
    mode = "valid";
    const compileQuery = {teamId: "team", modelId: document.request.model.modelId, source: "managed" as const,
      revision: document.request.model.revision, tokenizerRevision: "exact-tokenizer"};
    const source = {schemaVersion: "openpond.baseModelPreference.v1" as const, modelId: compileQuery.modelId,
      source: compileQuery.source, revision: compileQuery.revision, tokenizerRevision: compileQuery.tokenizerRevision,
      chatTemplateHash: null, modelAssetId: null};
    const form: ActivationExperimentFormDraft = {...activationForm, baseModel: source, maximumSpendUsd: "2",
      coordinates: [{id: "coordinate", layer: "0", neuron: "1", dose: "1"}], maxNewTokens: "2", doseMultipliers: "0, 1"};
    const descriptor = {vocabSize: 16, eosTokenIds: [15], encoding: "literal-fixture-v1"};
    const model = {...document.request.model, tokenizerHash: await canonicalSha256(descriptor)};
    compiledRequest = await compileActivationForm(form, {method: "neuron_steering", model,
      tokenizer: {source, descriptor, encode(text) { expect(text).toBe(form.prompts[0]!.text); return [1, 2, 3]; }}});
    expect(compiledRequest.variants[1].profile.entries[0].dose).toBe(0);
    const prepare = {teamId: "team", operationId: "prepare-modification", projectId: null, name: "Bounded reference",
      method: "neuron_steering" as const, query: compileQuery, request: compiledRequest, maximumSpendUsd: "2", sourceForm: form};
    const compile = {teamId: "team", projectId: null, method: prepare.method, query: prepare.query, form};
    expect((await client.compileModificationExecution(compile)).inputHash).toBe(await canonicalSha256(compiledRequest));
    mode = "compile-forged";
    await expect(client.compileModificationExecution(compile)).rejects.toThrow();
    mode = "valid";
    const prepared = await client.prepareModificationExecution(prepare);
    // A retained authoring snapshot must describe the exact operation; its
    // human-readable form cannot carry a different base or spending approval.
    await expect(client.prepareModificationExecution({...prepare, sourceForm: {...form, maximumSpendUsd: "3"}}))
      .rejects.toMatchObject({code: "managed_modification_authoring_mismatch"});
    const start = {teamId: "team", id: prepared.execution.id, operationId: "start-modification", expectedRevision: 1,
      planHash: prepared.execution.plan.contentHash, action: "start" as const, approvedMaximumSpendUsd: "2"};
    mode = "modification-lost-ack"; const before = modificationPosts;
    await expect(client.startModificationExecution(start)).rejects.toThrow();
    expect(modificationPosts).toBe(before + 1);
    mode = "valid"; const started = await client.startModificationExecution(start);
    const cancelled = await client.cancelModificationExecution({teamId: start.teamId, id: start.id, operationId: "cancel-modification",
      expectedRevision: 2, planHash: start.planHash, action: "cancel"});
    expect(cancelled.execution.phase).toBe("cancelled");
    expect(await client.startModificationExecution(start)).toEqual(started);
    expect(await client.prepareModificationExecution(prepare)).toEqual(prepared);
    mode = "modification-forged";
    await expect(client.startModificationExecution(start)).rejects.toThrow();
    // Switching methods and reopening must retain the trained artifact rather
    // than evaluate its original base. A valid outer record hash cannot bless
    // changed nested saved-version evidence.
    mode = "valid";
    const savedFixture = JSON.parse(readFileSync(new URL("../fixtures/python-foundation/training-model-save-http-workflow.json", import.meta.url), "utf8"));
    const {contentHash: _savedHash, ...savedContent} = {...savedFixture.receipt.version, teamId: "team"};
    const trainedVersion = {...savedContent, contentHash: await canonicalSha256(savedContent)};
    const trainedSource = {source: "trained" as const, label: "Exact trained checkpoint", inferenceModelId: null,
      baseModel: trainedVersion.request.baseModel, trainedVersion};
    let trainedRevision = 7;
    for (const operationType of ["grpo", "evaluate", "sft", "neuron_steering", "inspect_activations"] as const) {
      const draft = {schemaVersion: "openpond.experimentDraft.v1" as const, id: "draft", name: "Retained trained source", operationType,
        startingModel: trainedSource,
        ...(["sft", "grpo"].includes(operationType) ? {trainingForm: {...continued.record.draft.trainingForm!,
          baseModel: trainedSource.baseModel, recipe: {...continued.record.draft.trainingForm!.recipe, method: operationType},
          parent: {jobId: trainedVersion.jobId, artifact: trainedVersion.candidate.artifact,
            checkpointId: trainedVersion.candidate.checkpointId, adapterMode: "shared" as const}}} :
          operationType === "evaluate" ? {evaluationForm: input.draft.evaluationForm} :
          {activationForm: {...activationForm, baseModel: trainedSource.baseModel}})};
      const command = ExperimentDraftSaveSchema.parse({schemaVersion: "openpond.experimentDraftSave.v1", teamId: "team", projectId: "project",
        operationId: `trained-${operationType}`, expectedRevision: trainedRevision, draft});
      const receipt = await client.saveExperimentDraft(command);
      trainedRevision = receipt.record.revision;
      expect((await client.getExperimentDraft("team", "draft")).draft.startingModel).toEqual(trainedSource);
      expect(await client.saveExperimentDraft(command)).toEqual(receipt);
    }
    mode = "trained-version";
    await expect(client.getExperimentDraft("team", "draft")).rejects.toMatchObject({code: "training_model_version_mismatch"});
    mode = "valid";
    const beforeInvalid = mutations;
    for (const change of ["hash", "team", "base", "parent", "ordinary"]) {
      const source = structuredClone(trainedSource);
      if (change === "hash") source.trainedVersion.candidate.checkpointId = "changed-checkpoint";
      if (change === "team") {
        source.trainedVersion.teamId = "other-team";
        const {contentHash: _hash, ...content} = source.trainedVersion;
        source.trainedVersion.contentHash = await canonicalSha256(content);
      }
      if (change === "base") source.baseModel = {...source.baseModel, modelId: "different-base"};
      const draft = {schemaVersion: "openpond.experimentDraft.v1", id: "draft", name: "Rejected trained source", operationType: "grpo",
        startingModel: change === "ordinary" ? {...source, source: "managed"} : source,
        trainingForm: {...continued.record.draft.trainingForm!, baseModel: trainedSource.baseModel,
          parent: {jobId: trainedVersion.jobId, artifact: trainedVersion.candidate.artifact,
            checkpointId: change === "parent" ? "changed-checkpoint" : trainedVersion.candidate.checkpointId, adapterMode: "shared"}}};
      await expect(async () => client.saveExperimentDraft(ExperimentDraftSaveSchema.parse({...input, operationId: `reject-${change}`, expectedRevision: trainedRevision, draft}))).rejects.toThrow();
    }
    expect(mutations).toBe(beforeInvalid);

    // Future update preferences must survive reopening without fabricating a
    // first-stage parent or enabling a recurring schedule on a fresh base.
    const { parent: _parent, ...freshTraining } = continued.record.draft.trainingForm!;
    for (const continuationAdapterMode of ["residual_append", "sequential_merge"] as const) {
      const freshForm = { ...freshTraining, baseModel: trainedSource.baseModel,
        learningIntent: { ...freshTraining.learningIntent!, enabled: false, continuationAdapterMode } };
      const receipt = await client.saveExperimentDraft({ ...input, operationId: `fresh-future-${continuationAdapterMode}`, expectedRevision: trainedRevision,
        draft: { schemaVersion: "openpond.experimentDraft.v1", id: "draft", operationType: "grpo", name: "Fresh base with future updates",
          startingModel: { source: "managed", label: "Fresh base", baseModel: trainedSource.baseModel, inferenceModelId: null }, trainingForm: freshForm } });
      trainedRevision = receipt.record.revision;
      const reopened = (await client.getExperimentDraft("team", "draft")).draft.trainingForm!;
      expect(reopened.parent).toBeUndefined();
      expect(reopened.learningIntent).toEqual(freshForm.learningIntent);
      const settings = trainingExperimentLearningSettings(reopened);
      expect(settings.continuationAdapterMode).toBe(continuationAdapterMode);
      expect(settings.recipe?.continuation).toBeUndefined();
    }

  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
