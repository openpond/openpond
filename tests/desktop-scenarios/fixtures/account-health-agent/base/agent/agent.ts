import {
  action,
  defineAgentProject,
  defineWorkflow,
  editable,
} from "openpond-agent-sdk/primitives";
import { defineChannel } from "openpond-agent-sdk/channels";
import { defineEval } from "openpond-agent-sdk/eval";
import { defineInstructions } from "openpond-agent-sdk/instructions";

import {
  answerAccountHealthChat,
  buildWeeklyAccountReview,
  summarizeAccount,
  triageRenewalRisk,
  weeklyArtifactRefs,
} from "../src/account-health.js";
import { requiredAccountSummaries } from "../src/fixtures.js";

const chatWorkflow = defineWorkflow({
  name: "account-health-chat",
  description: "Answer account questions from deterministic, source-cited fixture facts.",
  run: answerAccountHealthChat,
});

const summarizeAccountWorkflow = defineWorkflow({
  name: "summarize-account",
  description: "Summarize one account using the checked-in account-health facts.",
  run: summarizeAccount,
});

const triageRenewalRiskWorkflow = defineWorkflow({
  name: "triage-renewal-risk",
  description: "Triage one account's renewal risk with billing and P1 blockers ranked first.",
  run: triageRenewalRisk,
});

const weeklyReviewWorkflow = defineWorkflow({
  name: "build-weekly-account-review",
  description: "Build a three-account weekly review and write Markdown, CSV, and JSON artifacts.",
  run: buildWeeklyAccountReview,
});

const fixtureSetup = {
  kind: "package" as const,
  name: "embedded-account-health-fixtures",
  required: false,
  description: "The generated source embeds the checked-in audit facts and needs no live integration.",
  status: "ready",
  satisfied: true,
  ready: true,
};

const tracedArtifacts = {
  outputArtifacts: [] as string[],
  persistRunSummary: true,
  persistTrace: true,
};

const inputSchemas = {
  AccountHealthChatInput: {
    title: "Account health chat input",
    type: "object",
    additionalProperties: false,
    required: ["prompt", "channel"],
    properties: {
      prompt: { type: "string", minLength: 1, description: "Account question or follow-up." },
      channel: { type: "string", const: "openpond_chat" },
    },
  },
  SummarizeAccountInput: {
    title: "Summarize account input",
    type: "object",
    additionalProperties: false,
    required: ["accountId"],
    properties: {
      accountId: { type: "string", enum: ["acme", "northstar", "glacier"] },
    },
  },
  TriageRenewalRiskInput: {
    title: "Triage renewal risk input",
    type: "object",
    additionalProperties: false,
    required: ["accountId", "asOfDate"],
    properties: {
      accountId: { type: "string", enum: ["acme", "northstar", "glacier"] },
      asOfDate: { type: "string", format: "date" },
    },
  },
  WeeklyAccountReviewInput: {
    title: "Weekly account review input",
    type: "object",
    additionalProperties: false,
    required: ["asOfDate", "minimumRisk"],
    properties: {
      asOfDate: { type: "string", format: "date" },
      minimumRisk: { type: "string", enum: ["low", "medium", "high"] },
    },
  },
  AccountHealthResponse: {
    title: "Account health response",
    type: "object",
    additionalProperties: true,
    required: ["text", "intent"],
    properties: {
      text: { type: "string" },
      intent: { type: "string" },
      artifactRefs: { type: "array", items: { type: "string" } },
      metadata: { type: "object" },
    },
  },
  WeeklyAccountReviewResponse: {
    title: "Weekly account review response",
    type: "object",
    additionalProperties: true,
    required: ["text", "intent", "artifactRefs"],
    properties: {
      text: { type: "string" },
      intent: { const: "build-weekly-account-review" },
      artifactRefs: {
        type: "array",
        prefixItems: weeklyArtifactRefs.map((artifactRef) => ({ const: artifactRef })),
        minItems: 3,
        maxItems: 3,
      },
      metadata: { type: "object" },
    },
  },
};

export default defineAgentProject({
  name: "Account Health Agent",
  version: "0.1.0",
  useCase: "account-health",
  description:
    "Monitor customer account health, answer source-backed questions, triage renewal risk, and produce weekly reviews with owners and next steps.",
  manifestMode: "typescript",
  runtime: { base: "node-bun-workspace", networkPolicy: "none" },
  instructions: defineInstructions("./agent/instructions.md"),
  inputSchema: inputSchemas.AccountHealthChatInput,
  inputSchemas,
  defaultAction: "chat",
  actions: [
    action("chat", {
      label: "Chat",
      description: "Answer account-health questions with deterministic, source-backed facts.",
      target: { kind: "workflow", workflow: chatWorkflow },
      visibility: "default",
      timeoutSeconds: 30,
      inputSchema: "AccountHealthChatInput",
      outputSchema: "AccountHealthResponse",
      approval: { mode: "never", reason: "Read-only fixture-backed account analysis." },
      artifacts: tracedArtifacts,
      setup: [
        fixtureSetup,
        {
          kind: "channel",
          name: "openpond_chat",
          required: false,
          description: "Built-in OpenPond Chat channel; no external setup is required.",
          status: "ready",
          satisfied: true,
          ready: true,
        },
      ],
      mcp: { enabled: false },
      schedule: { enabled: false, allowAdHoc: true },
      trace: { name: "chat", namespace: "account-health" },
    }),
    action("summarize-account", {
      label: "Summarize Account",
      description: "Return a source-cited health summary for Acme, Northstar, or Glacier.",
      target: { kind: "workflow", workflow: summarizeAccountWorkflow },
      visibility: "end_user",
      timeoutSeconds: 30,
      inputSchema: "SummarizeAccountInput",
      outputSchema: "AccountHealthResponse",
      approval: { mode: "never", reason: "Read-only fixture-backed account analysis." },
      artifacts: tracedArtifacts,
      setup: [fixtureSetup],
      mcp: { enabled: false },
      schedule: { enabled: false, allowAdHoc: true },
      trace: { name: "summarize-account", namespace: "account-health" },
    }),
    action("triage-renewal-risk", {
      label: "Triage Renewal Risk",
      description: "Rank renewal blockers for one account as of a supplied date, with billing and P1 first.",
      target: { kind: "workflow", workflow: triageRenewalRiskWorkflow },
      visibility: "end_user",
      timeoutSeconds: 30,
      inputSchema: "TriageRenewalRiskInput",
      outputSchema: "AccountHealthResponse",
      approval: { mode: "never", reason: "Read-only fixture-backed renewal triage." },
      artifacts: tracedArtifacts,
      setup: [fixtureSetup],
      mcp: { enabled: false },
      schedule: { enabled: false, allowAdHoc: true },
      trace: { name: "triage-renewal-risk", namespace: "account-health" },
    }),
    action("build-weekly-account-review", {
      label: "Build Weekly Account Review",
      description: "Write a weekly account review with all accounts, explicit owners, next steps, and source citations.",
      target: { kind: "workflow", workflow: weeklyReviewWorkflow },
      visibility: "end_user",
      timeoutSeconds: 30,
      inputSchema: "WeeklyAccountReviewInput",
      outputSchema: "WeeklyAccountReviewResponse",
      approval: {
        mode: "never",
        reason: "Writes only deterministic review artifacts under the generated project artifact directory.",
      },
      outputArtifacts: [...weeklyArtifactRefs],
      artifacts: {
        outputArtifacts: [...weeklyArtifactRefs],
        persistRunSummary: true,
        persistTrace: true,
      },
      setup: [fixtureSetup],
      mcp: { enabled: false },
      schedule: { enabled: false, allowAdHoc: true },
      trace: { name: "build-weekly-account-review", namespace: "account-health" },
    }),
  ],
  workflows: [
    chatWorkflow,
    summarizeAccountWorkflow,
    triageRenewalRiskWorkflow,
    weeklyReviewWorkflow,
  ],
  channels: [
    defineChannel({
      id: "openpond_chat",
      target: { action: "chat" },
      enabledByDefault: true,
      normalizeEvent: (event) => ({
        prompt: String(event.prompt ?? ""),
        channel: "openpond_chat",
      }),
      renderResponse: (result) => ({
        text: result.text,
        artifactRefs: result.artifactRefs ?? [],
        metadata: result.metadata ?? {},
      }),
    }),
  ],
  editable: editable({
    enabled: true,
    backend: "openpond-coding-work-item",
    runtimeEnvironmentId: "openpond-coding-core-v1",
    sourceOfTruth: "agent-source",
    policyDiscovery: {
      command: "openpond agent inspect --json",
      runAfter: "source-materialized",
    },
    allowedPaths: ["agent/**", "src/**", "package.json"],
    requiredChecks: ["openpond-agent validate", "openpond-agent eval"],
    defaultResultMode: "patch_only",
  }),
  evals: [
    defineEval({
      name: "acme-chat-publish-gate",
      description:
        "The default chat action answers Acme with every fixture fact and keeps billing/P1 ahead of adoption on follow-up.",
      publishGate: true,
      async run(t) {
        await t.send({
          prompt: "Summarize Acme with source-backed facts.",
          channel: "openpond_chat",
        });
        t.expectIntent("account-health-chat");
        t.expectTextIncludes(requiredAccountSummaries.acme);
        t.expectTraceEvent("account-health.account-summarized");
        await t.send({
          prompt: "What should we do first, and who owns it?",
          channel: "openpond_chat",
        });
        t.expectTextIncludes("Resolve the billing dispute and P1 first");
        t.expectTextIncludes("Owner: Revenue Operations with Support");
      },
    }),
    defineEval({
      name: "northstar-summary-publish-gate",
      description: "The repeatable summary action returns the approved Northstar expansion facts and citations.",
      publishGate: true,
      async run(t) {
        await t.runAction("summarize-account", {
          prompt: "",
          channel: "openpond_chat",
          accountId: "northstar",
        });
        t.expectIntent("summarize-account");
        t.expectTextIncludes(requiredAccountSummaries.northstar);
      },
    }),
    defineEval({
      name: "acme-renewal-triage-publish-gate",
      description: "The renewal action accepts composer JSON and returns the approved Acme risk ordering and citations.",
      publishGate: true,
      async run(t) {
        await t.runAction("triage-renewal-risk", {
          prompt: JSON.stringify({ accountId: "acme", asOfDate: "2026-07-20" }),
          channel: "openpond_chat",
        });
        t.expectIntent("triage-renewal-risk");
        t.expectTextIncludes(requiredAccountSummaries.acme);
        t.expectTraceEvent("account-health.renewal-risk-triaged");
      },
    }),
    defineEval({
      name: "weekly-account-review-artifacts-publish-gate",
      description:
        "The weekly review covers all accounts with owners and next steps and traces its Markdown, CSV, and JSON artifacts.",
      expectedArtifacts: [...weeklyArtifactRefs],
      publishGate: true,
      async run(t) {
        await t.runAction("build-weekly-account-review", {
          prompt: "",
          channel: "openpond_chat",
          asOfDate: "2026-07-20",
          minimumRisk: "medium",
        });
        t.expectIntent("build-weekly-account-review");
        t.expectTextIncludes("Weekly account review");
        t.expectTextIncludes("Acme");
        t.expectTextIncludes("Glacier");
        t.expectTextIncludes("Northstar");
        for (const artifactRef of weeklyArtifactRefs) t.expectArtifact(artifactRef);
        t.expectTraceEvent("account-health.weekly-review-built");
      },
    }),
  ],
});
