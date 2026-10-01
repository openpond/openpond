import { z } from "zod";
import {
  HostedTrainingPolicyDetailSchema,
  HostedTrainingPolicyControlSchema,
  verifyPostTrainingPlan,
  HostedTrainingSetupCatalogSchema,
  PostTrainingAttachmentSchema,
  AttachPostTrainingSchema,
} from "openpond-sdk/post-training";
import { createModelProjectsClient } from "openpond-sdk/model-projects";
import {
  OpenPondLearningClient,
  LearningCommandRequestSchema,
  LearningPolicySchema,
  assertLearningContentHash,
  learningRef,
  sameLearningRef,
  type LearningResourceFor,
} from "openpond-sdk/learning";
import { OpenPondTrainingProjectClient } from "openpond-sdk/training-projects";
import { OpenPondExperimentsClient, RunExperimentSchema } from "openpond-sdk/experiments";
import {
  createTrainingClient,
  TrainingPreparationRequestSchema,
  TrainingPreparationControlSchema,
} from "openpond-sdk/training";
import { hostedApiAuthHeaders } from "../openpond/hosted-api-access.js";
const Id = z.string().min(1).max(200);
export function createHostedTrainingSetup(input: {
  teamId: string;
  actorId: string;
  access: { apiBaseUrl: string; token: string };
  currentIdentity: () => Promise<{ teamId: string; actorId: string } | null>;
}) {
  async function fence() {
    const current = await input.currentIdentity();
    if (current?.teamId !== input.teamId || current.actorId !== input.actorId)
      throw new Error("The active account changed. Reopen training setup.");
  }
  const headers = () => {
    const value = hostedApiAuthHeaders(input.access.token);
    value.set("x-openpond-team-id", input.teamId);
    return value;
  };
  const scopedFetch: typeof fetch = async (...args) => {
    await fence();
    const value = await fetch(...args);
    await fence();
    return value;
  };
  const config = createModelProjectsClient({
    baseUrl: input.access.apiBaseUrl,
    headers,
    fetch: scopedFetch,
  });
  const train = createTrainingClient({
    baseUrl: input.access.apiBaseUrl,
    headers,
    fetch: scopedFetch,
  });
  const learn = new OpenPondLearningClient({
    baseUrl: input.access.apiBaseUrl,
    apiKey: input.access.token,
    scope: input.teamId,
    fetch: scopedFetch,
  });
  const projects = new OpenPondTrainingProjectClient({
    baseUrl: input.access.apiBaseUrl,
    apiKey: input.access.token,
    teamId: input.teamId,
    fetch: scopedFetch,
  });
  const experiments = new OpenPondExperimentsClient({
    baseUrl: input.access.apiBaseUrl,
    apiKey: input.access.token,
    teamId: input.teamId,
    fetch: scopedFetch,
  });
  async function all<K extends "batch" | "source" | "definition">(kind: K) {
    const result: LearningResourceFor<K>[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let n = 0; ; n++) {
      if (n >= 100)
        throw new Error("The complete learning catalog exceeds the supported setup bound.");
      const page = await learn.list(kind, { limit: 100, ...(cursor ? { afterId: cursor } : {}) });
      result.push(...page.items);
      if (!page.nextCursor) return result;
      if (seen.has(page.nextCursor)) throw new Error("Learning pagination did not advance.");
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  }
  async function publicRequest(path: string, body: unknown) {
    await fence();
    const h = headers();
    h.set("content-type", "application/json");
    const response = await scopedFetch(`${input.access.apiBaseUrl.replace(/\/+$/, "")}${path}`, {
      method: "POST",
      headers: h,
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Training setup returned no receipt.");
    const chunks: Uint8Array[] = [];
    let count = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        count += chunk.value.byteLength;
        if (count > 8_388_608) throw new Error("The setup response exceeded its bound.");
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    await fence();
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!response.ok)
      throw new Error(
        typeof value.message === "string"
          ? value.message
          : `Training setup failed (${response.status}).`,
      );
    return value;
  }
  async function policyConfiguration(portableId: string) {
    const selected = (await config.list()).find(
      (project) => project.portableProjectId === portableId,
    );
    if (!selected)
      throw new Error(
        "The current account cannot read this policy’s exact hosted training configuration.",
      );
    return selected;
  }
  return {
    async policyRead(id: string, afterId?: string) {
      await fence();
      const policy = await learn.get("policy", Id.parse(id));
      const selected = await policyConfiguration(policy.modelProjectId);
      if (
        policy.executionOwner !== "hosted" ||
        selected.portableProjectId !== policy.modelProjectId
      )
        throw new Error("The policy has no exact hosted training configuration.");
      const [inspection, page] = await Promise.all([
        learn.inspectPolicy(learningRef(policy)),
        learn.list("iteration", { parentId: policy.id, limit: 100, afterId }),
      ]);
      const iterations = await Promise.all(
        page.items.map(async (iteration) => {
          if (iteration.policy.id !== policy.id)
            throw new Error("Iteration belongs to another learning policy.");
          return {
            iteration,
            evals: iteration.trainingJob
              ? await train.postTraining.get(input.teamId, iteration.trainingJob.id)
              : null,
          };
        }),
      );
      await fence();
      return HostedTrainingPolicyDetailSchema.parse({
        teamId: input.teamId,
        actorId: input.actorId,
        configuration: selected,
        policy,
        inspection,
        iterations,
        nextCursor: page.nextCursor,
      });
    },
    async policyControl(raw: unknown) {
      await fence();
      const body = HostedTrainingPolicyControlSchema.parse(raw),
        policy = await learn.get("policy", body.id, body.expectedRevision);
      if (policy.contentHash !== body.policyHash || policy.executionOwner !== "hosted")
        throw new Error("The exact reviewed policy changed.");
      const selected = await policyConfiguration(policy.modelProjectId);
      if (selected.portableProjectId !== policy.modelProjectId)
        throw new Error("The exact policy configuration changed.");
      if (body.action === "pause" || body.action === "resume") {
        const { contentHash: _hash, ...content } = policy;
        void _hash;
        return learn.command({
          action: "publish",
          operationId: body.operationId,
          kind: "policy",
          expectedRevision: body.expectedRevision,
          content: { ...content, revision: policy.revision + 1, enabled: body.action === "resume" },
        });
      }
      if (body.action === "reserve")
        return learn.command({
          action: "reserve_iteration",
          operationId: body.operationId,
          policy: learningRef(policy),
          trigger: { kind: "manual", identity: body.operationId },
        });
      if (!body.iterationId || !body.iterationRevision)
        throw new Error("Choose the exact current iteration before controlling it.");
      const iteration = await learn.get("iteration", body.iterationId, body.iterationRevision);
      if (iteration.policy.id !== policy.id)
        throw new Error("The iteration belongs to another policy.");
      return learn.command({
        action:
          body.action === "cancel-iteration" ? "cancel_iteration" : "retry_iteration_dispatch",
        operationId: body.operationId,
        iterationId: iteration.id,
        expectedRevision: iteration.revision,
      });
    },
    async catalog(raw: { configurationId: string; projectId: string | null }) {
      await fence();
      const selected = (await config.get(Id.parse(raw.configurationId))).project;
      if (raw.projectId) {
        const project = await projects.get(raw.projectId);
        if (
          project.archived ||
          !project.content.resources.some(
            (r) => r.kind === "training_configuration" && r.resourceId === selected.id,
          )
        )
          throw new Error(
            "Link this exact training configuration to the current Project before setup.",
          );
      }
      const [batches, sources, definitions] = await Promise.all([
        all("batch"),
        all("source"),
        all("definition"),
      ]);
      const frozen = [];
      let afterId: string | undefined;
      const seen = new Set<string>();
      for (let n = 0; ; n++) {
        if (n >= 100)
          throw new Error("The complete evaluation catalog exceeds the supported setup bound.");
        const page = await experiments.list({
          projectId: raw.projectId ?? undefined,
          limit: 100,
          afterId,
        });
        for (const item of page.items) {
          if (item.request.policy.kind === "fixture") continue;
          frozen.push({
            id: item.summary.id,
            name: item.request.name ?? item.summary.id,
            configuration: RunExperimentSchema.parse({
              request: item.request,
              maximumCostUsd: item.configuration.maximumCostUsd,
              graders: item.configuration.graders.map((p) => ({
                id: p.id,
                version: p.version,
                contentHash: p.contentHash,
                mappings: p.mappings ?? [],
              })),
              operationId: item.request.operationId,
            }),
            graders: item.configuration.graders.map((p) => ({
              feedbackKey: p.feedbackKey,
              name: p.feedbackKey,
              ref: {
                id: p.release?.id ?? p.id,
                contentHash: p.release?.contentHash ?? p.contentHash,
              },
            })),
          });
        }
        if (!page.nextCursor) break;
        if (seen.has(page.nextCursor)) throw new Error("Evaluation pagination did not advance.");
        seen.add(page.nextCursor);
        afterId = page.nextCursor;
      }
      const reward = selected.trainingSetup.rewardBindingRef;
      await fence();
      return HostedTrainingSetupCatalogSchema.parse({
        teamId: input.teamId,
        actorId: input.actorId,
        projectId: raw.projectId,
        configuration: selected,
        batches: batches.filter(
          (b) =>
            b.purpose === "reward_training" && reward && sameLearningRef(b.rewardBinding, reward),
        ),
        sources: sources.filter((s) =>
          definitions.some(
            (d) =>
              sameLearningRef(learningRef(d), s.taskDefinition) &&
              reward &&
              sameLearningRef(d.rewardBinding, reward),
          ),
        ),
        definitions,
        experiments: frozen,
      });
    },
    async perform(action: "prepare" | "start" | "cancel" | "publish" | "attach", raw: unknown) {
      await fence();
      if (action === "prepare") {
        const body = TrainingPreparationRequestSchema.parse(raw);
        if (body.teamId !== input.teamId) throw new Error("Training workspace changed.");
        return train.prepareRun(body);
      }
      if (action === "start" || action === "cancel") {
        const body = z
          .object({ id: Id, control: TrainingPreparationControlSchema })
          .strict()
          .parse(raw);
        if (body.control.teamId !== input.teamId) throw new Error("Training workspace changed.");
        return action === "start"
          ? train.startPreparation(body.id, body.control)
          : train.cancelPreparation(body.id, body.control);
      }
      if (action === "attach") {
        const body = AttachPostTrainingSchema.parse(raw);
        return train.postTraining.attach(input.teamId, body);
      }
      const body = z
        .object({
          operationId: Id,
          command: z.unknown(),
          attachment: PostTrainingAttachmentSchema.nullable(),
        })
        .strict()
        .parse(raw);
      const command = LearningCommandRequestSchema.parse({
        scope: input.teamId,
        command: body.command,
      }).command;
      if (command.action !== "publish" || command.kind !== "policy")
        throw new Error("Publish one exact hosted learning policy.");
      if (body.attachment) {
        const result = await publicRequest("/v1/training/post-training-policies", {
          operationId: body.operationId,
          command,
          attachment: body.attachment,
        });
        const policy = LearningPolicySchema.parse(result.policy),
          plan = verifyPostTrainingPlan(result.plan);
        assertLearningContentHash(policy);
        if (
          policy.id !== command.content.id ||
          policy.revision !== command.content.revision ||
          plan.attachment.binding.contentHash !== policy.contentHash ||
          plan.ownerUserId !== input.actorId
        )
          throw new Error("Publication returned a different policy, plan or owner.");
        return { policy, plan };
      }
      return learn.command(command);
    },
  };
}
