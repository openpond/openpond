import { access, readFile } from "node:fs/promises";
import path from "node:path";
import type { BootstrapPayload, RuntimeEvent, Session } from "@openpond/contracts";

import { desktopScenario } from "../../scripts/desktop-harness/scenario";
import {
  asRecord,
  configureCodingSubagentModel,
  expandChildSessionGroup,
  registerScriptedOpenPondModel,
  reloadRenderer,
  stringFromRecord,
  toolResultFromEvent,
  waitForAssistantOutput,
  waitForCompletedTurn,
  waitForSidebarSessionRow,
} from "./helpers";

const modelRef = {
  providerId: "openpond" as const,
  modelId: "openpond-scripted-subagent-bounded-worker",
};

const proofPath = "bounded-worker-contract-proof.txt";
const validationCommand = "test -f bounded-worker-contract-proof.txt && grep -q bounded-worker-contract bounded-worker-contract-proof.txt";

export default desktopScenario({
  name: "subagent-bounded-worker-contract",
  mode: "isolated",
  timeoutMs: 150_000,
  async run(harness) {
    await assertMissing(path.join(harness.repoRoot, proofPath), "parent checkout proof file before run");
    await registerScriptedOpenPondModel(harness, modelRef);
    await configureCodingSubagentModel(harness, modelRef);

    const title = harness.uniqueTitle("subagent-bounded-worker-contract");
    const session = await harness.api.createSession<Session>({
      provider: "openpond",
      modelRef,
      title,
      cwd: harness.repoRoot,
      openPondCommandAccessMode: "full-access",
    });

    await reloadRenderer(harness);
    await harness.renderer.selectSession(session.id);
    await harness.renderer.assertText(title, { label: "bounded worker parent session title" });
    harness.recordMetadata({
      parentSessionId: session.id,
      title,
      modelRef,
      proofPath,
      validationCommand,
    });

    await harness.renderer.submitComposer("Start the scripted bounded-worker coding subagent and let it validate its isolated edit.");
    const startEvent = await harness.events.waitForToolCompleted(
      session.id,
      "openpond_subagent_start",
    ) as RuntimeEvent;
    const startResult = toolResultFromEvent(startEvent);
    const runId = stringFromRecord(startResult, "runId");
    const childSessionId = stringFromRecord(startResult, "childSessionId");
    if (!runId) throw new Error("openpond_subagent_start did not return a runId.");
    if (!childSessionId) throw new Error("openpond_subagent_start did not return a childSessionId.");
    await waitForCompletedTurn(harness, session.id, startEvent, "bounded worker parent turn completion");

    const submittedEvent = await harness.events.waitForSubagentSubmitted(session.id, runId) as RuntimeEvent;
    await harness.events.waitForToolCompleted(childSessionId, "exec_command", { timeoutMs: 30_000 }) as RuntimeEvent;
    await waitForAssistantOutput(
      harness,
      childSessionId,
      "Coding subagent submitted the bounded worker contract packet after editing and validation.",
      "bounded worker child final report",
    );

    const bootstrap = await harness.api.bootstrap<BootstrapPayload>();
    const childSession = bootstrap.sessions.find((item) => item.id === childSessionId);
    if (!childSession) throw new Error(`Child session ${childSessionId} was not present in bootstrap.`);
    if (childSession.parentSessionId !== session.id) {
      throw new Error(`Child session ${childSessionId} was not linked to parent ${session.id}.`);
    }
    if (!childSession.cwd || childSession.cwd === harness.repoRoot) {
      throw new Error(`Expected child session cwd to be an isolated worktree, received ${childSession.cwd ?? "none"}.`);
    }
    if (!childSession.cwd.includes("openpond-subagents")) {
      throw new Error(`Expected child cwd to use the subagent worktree area, received ${childSession.cwd}.`);
    }

    const submittedRun = asRecord(asRecord(submittedEvent.data)?.run);
    assertRunField(submittedRun, "status", "submitted_for_review");
    assertRunField(submittedRun, "roleId", "coding");
    assertRunField(submittedRun, "isolationMode", "copy_on_write");
    const review = asRecord(submittedRun?.review);
    assertRunField(review, "status", "submitted_for_review");
    const workerBrief = asRecord(submittedRun?.workerBrief);
    assertStringArrayIncludes(workerBrief, "plan", "Inspect workspace context.");
    assertStringArrayIncludes(workerBrief, "targetFiles", proofPath);
    assertStringArrayIncludes(workerBrief, "validationCommands", validationCommand);

    const progress = asRecord(submittedRun?.progress);
    assertRunField(progress, "phase", "submitted");
    assertStringArrayIncludes(progress, "inspectedFiles", "package.json");
    assertStringArrayIncludes(progress, "repeatedSearches", "resource_search:package.json");
    assertStringArrayIncludes(progress, "changedFiles", proofPath);
    const validationAttempts = unknownArrayFromRecord(progress, "validationAttempts")
      .map((item) => asRecord(item))
      .filter((item): item is Record<string, unknown> => Boolean(item));
    if (!validationAttempts.some((attempt) =>
      stringFromRecord(attempt, "command") === validationCommand &&
      stringFromRecord(attempt, "status") === "passed"
    )) {
      throw new Error(`Expected a passed validation attempt for ${validationCommand}.`);
    }

    const metadata = asRecord(submittedRun?.metadata);
    const workspace = asRecord(metadata?.subagentWorkspace);
    assertRunField(workspace, "mode", "copy_on_write");
    const workspaceHandoff = asRecord(metadata?.workspaceHandoff);
    assertRunField(workspaceHandoff, "status", "captured");
    assertStringArrayIncludes(workspaceHandoff, "changedFiles", proofPath);
    if (!String(workspaceHandoff?.patchPreview ?? "").includes(proofPath)) {
      throw new Error("Expected workspace handoff patch preview to mention the proof file.");
    }

    const childProof = await readFile(path.join(childSession.cwd, proofPath), "utf8");
    if (!childProof.includes("bounded-worker-contract")) {
      throw new Error(`Child proof file did not contain the expected marker: ${childProof}`);
    }
    await assertMissing(path.join(harness.repoRoot, proofPath), "parent checkout proof file after run");

    await harness.renderer.selectSession(session.id, { timeoutMs: 10_000 });
    await harness.renderer.assertText("Subagent submitted", { label: "bounded worker submitted activity visible" });
    await harness.renderer.assertText("Coding subagent", { label: "bounded worker coding label visible" });
    harness.recordAssertion("submittedForReviewNotAccepted", true);
    harness.recordAssertion("structuredWorkerBriefPersisted", true);
    harness.recordAssertion("progressLedgerDerived", true);
    harness.recordAssertion("copyOnWriteChildWorkspaceUsed", true);
    harness.recordAssertion("parentCheckoutUnchanged", true);
    harness.recordAssertion("workspaceHandoffCaptured", true);

    await expandChildSessionGroup(harness, session.id);
    await waitForSidebarSessionRow(harness, childSession.id, { timeoutMs: 10_000 });
    await harness.renderer.selectSession(childSessionId, { timeoutMs: 10_000 });
    await harness.renderer.assertText("Coding subagent submitted the bounded worker contract packet", {
      label: "bounded worker child transcript visible",
    });

    const parentEvents = bootstrap.events.filter((event) => event.sessionId === session.id);
    const childEvents = bootstrap.events.filter((event) => event.sessionId === childSessionId);
    harness.recordMetadata({
      runId,
      childSessionId,
      parentTurnId: startEvent.turnId ?? null,
      childCwd: childSession.cwd,
      parentRuntimeEventCount: parentEvents.length,
      childRuntimeEventCount: childEvents.length,
      childToolActions: childEvents
        .filter((event) => event.name === "tool.completed" || event.name === "workspace_action_result")
        .map((event) => event.action ?? stringFromRecord(asRecord(event.data), "tool") ?? event.name),
    });

    await harness.renderer.selectSession(session.id, { timeoutMs: 10_000 });
    await harness.screenshot("subagent-bounded-worker-contract-complete");
  },
});

async function assertMissing(filePath: string, label: string): Promise<void> {
  try {
    await access(filePath);
  } catch {
    return;
  }
  throw new Error(`Expected ${label} to be absent: ${filePath}`);
}

function assertRunField(record: Record<string, unknown> | null | undefined, key: string, expected: string): void {
  const actual = stringFromRecord(record, key);
  if (actual !== expected) throw new Error(`Expected ${key} to be ${expected}, received ${actual ?? "none"}.`);
}

function assertStringArrayIncludes(
  record: Record<string, unknown> | null | undefined,
  key: string,
  expected: string,
): void {
  const values = arrayFromRecord(record, key);
  if (!values.includes(expected)) {
    throw new Error(`Expected ${key} to include ${expected}; received ${JSON.stringify(values)}.`);
  }
}

function arrayFromRecord(record: Record<string, unknown> | null | undefined, key: string): string[] {
  return unknownArrayFromRecord(record, key).filter((item): item is string => typeof item === "string");
}

function unknownArrayFromRecord(record: Record<string, unknown> | null | undefined, key: string): unknown[] {
  const value = record?.[key];
  return Array.isArray(value) ? value : [];
}
