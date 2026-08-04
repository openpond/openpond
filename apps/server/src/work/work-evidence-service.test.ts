import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  FileOutputRefSchema,
  type RuntimeEvent,
  type Session,
  type Turn,
} from "@openpond/contracts";
import { contentHash, sha256 } from "@openpond/evals";
import {
  classifyWorkEvidence,
  verifyWorkEvidenceReceipt,
  verifyWorkFeedbackReceipt,
  verifyWorkProcessTrace,
} from "@openpond/evals/evidence";
import { afterEach, describe, expect, test } from "vitest";

import { SqliteStore } from "../store/store.js";
import {
  projectDesktopWorkEvidence,
  type DesktopWorkEvidenceConsent,
} from "./desktop-work-evidence-projector.js";
import {
  captureDesktopWorkEvidence,
  recordDesktopWorkFeedback,
} from "./work-evidence-service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

describe("Desktop Work evidence service", () => {
  test("persists one idempotent Agent and environment trace without portable raw payloads", async () => {
    const storeDir = await temporaryStore();
    const store = new SqliteStore(storeDir);
    const session = workSession();
    const turn = completedTurn();
    await store.insertSessionAtFront(session);
    await store.insertTurn(turn);
    const output = await managedOutput(storeDir, turn);
    for (const event of completedEvents(output)) await store.appendRuntimeEvent(event);

    const first = await captureDesktopWorkEvidence({
      store,
      storeDir,
      sessionId: session.id,
      turnId: turn.id,
      consent: consent(),
      agentSnapshot: {
        id: "historical-agent-snapshot",
        contentHash: contentHash("historical-agent-snapshot"),
      },
      now: () => "2026-08-04T12:00:03.000Z",
    });
    const second = await captureDesktopWorkEvidence({
      store,
      storeDir,
      sessionId: session.id,
      turnId: turn.id,
      consent: consent(),
      agentSnapshot: {
        id: "historical-agent-snapshot",
        contentHash: contentHash("historical-agent-snapshot"),
      },
      now: () => "2026-08-04T12:01:00.000Z",
    });

    expect(second).toEqual(first);
    expect(verifyWorkEvidenceReceipt(first.receipt)).toBe(true);
    expect(verifyWorkProcessTrace(first.trace)).toBe(true);
    expect(first.receipt.outputRefs).toHaveLength(1);
    expect(first.receipt.validationEvidenceRefs).toHaveLength(1);
    expect(first.receipt.artifactRefs[0]?.contentHash).toBe(output.sha256);
    const agentTool = first.trace.steps.find((step) =>
      step.layer === "agent" && step.action === "tool_invoked"
    );
    const environment = first.trace.steps.find((step) =>
      step.layer === "environment"
      && step.kind === "tool"
      && step.action === "tool_completed"
    );
    expect(agentTool?.receiptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(environment).toMatchObject({
      parentReceiptHash: agentTool?.receiptHash,
      attributes: {
        exitCode: 0,
        durationMs: 600,
        cpuTimeMs: 420,
        memoryPeakBytes: 67_108_864,
      },
    });
    expect(first.trace.steps).toContainEqual(expect.objectContaining({
      layer: "environment",
      kind: "validation",
      action: "validation_completed",
      parentReceiptHash: agentTool?.receiptHash,
    }));
    expect(first.trace.steps.map((step) => step.sequence)).toEqual(
      first.trace.steps.map((_, index) => index),
    );
    const portableTrace = first.artifacts.find((artifact) => artifact.kind === "sanitized_trace")!;
    const privateTrace = first.artifacts.find((artifact) => artifact.kind === "private_trace")!;
    const portableText = await readFile(portableTrace.path, "utf8");
    const privateText = await readFile(privateTrace.path, "utf8");
    expect(portableText).not.toContain("hidden chain of thought");
    expect(portableText).not.toContain("secret prompt");
    expect(portableText).not.toContain(session.id);
    expect(privateText).toContain("hidden chain of thought");
    expect(privateText).toContain("secret prompt");
    await store.close();
  });

  test("persists append-only feedback for an exact output revision and private correction", async () => {
    const storeDir = await temporaryStore();
    const store = new SqliteStore(storeDir);
    const session = workSession();
    const turn = completedTurn();
    await store.insertSessionAtFront(session);
    await store.insertTurn(turn);
    const output = await managedOutput(storeDir, turn);
    for (const event of completedEvents(output)) await store.appendRuntimeEvent(event);
    const evidence = await captureDesktopWorkEvidence({
      store,
      storeDir,
      sessionId: session.id,
      turnId: turn.id,
      consent: consent(),
      now: () => "2026-08-04T12:00:03.000Z",
    });
    const outputRevision = evidence.receipt.outputRefs[0]!;
    const correction = await recordDesktopWorkFeedback({
      store,
      storeDir,
      evidenceReceiptId: evidence.receipt.id,
      outputRevisionHash: outputRevision.contentHash,
      verdict: "needs_correction",
      reasonCodes: ["incomplete"],
      correction: "Add the missing audit section.",
      now: () => "2026-08-04T12:02:00.000Z",
    });
    const accepted = await recordDesktopWorkFeedback({
      store,
      storeDir,
      evidenceReceiptId: evidence.receipt.id,
      outputRevisionHash: outputRevision.contentHash,
      verdict: "accepted",
      reasonCodes: ["correct"],
      now: () => "2026-08-04T12:03:00.000Z",
    });

    expect(verifyWorkFeedbackReceipt(correction.receipt)).toBe(true);
    expect(correction.receipt.correctionRef).not.toBeNull();
    expect(correction.artifacts.find((artifact) => artifact.kind === "correction")).toMatchObject({
      visibility: "private",
    });
    expect(verifyWorkFeedbackReceipt(accepted.receipt)).toBe(true);
    await expect(store.listWorkFeedbackForEvidence(evidence.receipt)).resolves.toHaveLength(2);
    await store.close();
  });

  test.each([
    ["failed", "Provider unavailable", "failed", "infrastructure_failure"],
    ["interrupted", "Timed out waiting for sandbox", "timeout", "timeout"],
    ["interrupted", "Stopped by user", "cancelled", "cancelled"],
  ] as const)(
    "classifies %s terminal Work without inventing evaluation success",
    (status, error, expectedStatus, expectedFailure) => {
      const turn = completedTurn({ status, error });
      const projected = projectDesktopWorkEvidence({
        session: workSession(),
        turn,
        runtimeEvents: [event("start", "turn.started", turn.startedAt), terminalEvent(turn)],
        usageRecords: [],
        consent: consent(),
      });
      expect(projected.receipt.terminal).toEqual({
        status: expectedStatus,
        failureClass: expectedFailure,
      });
    },
  );

  test("marks delayed terminal evidence incomplete, synthesizes only the authoritative state, and preserves a missing snapshot", () => {
    const turn = completedTurn();
    const projected = projectDesktopWorkEvidence({
      session: workSession(),
      turn,
      runtimeEvents: [
        event("duplicate", "turn.started", turn.startedAt),
        event("duplicate", "turn.started", turn.startedAt),
      ],
      usageRecords: [],
      consent: consent(),
      agentSnapshot: null,
    });
    expect(projected.receipt.agentSnapshot).toBeNull();
    expect(projected.sanitizedTrace.incompleteReasons).toContain("missing_terminal");
    expect(projected.sanitizedTrace.steps.at(-1)).toMatchObject({
      layer: "agent",
      action: "turn_completed",
      status: "completed",
    });
    const eligibility = classifyWorkEvidence({
      evidence: projected.receipt,
      policyState: "active",
      reconstructability: { input: true, environment: true, verifier: true },
    });
    expect(eligibility.decisions.eval_candidate.blockers).toEqual(
      expect.arrayContaining(["trace_incomplete", "agent_snapshot_missing", "output_missing"]),
    );
  });

  test("rejects transcript-only consent and creator-only multi-participant projection", () => {
    const turn = completedTurn();
    expect(() => projectDesktopWorkEvidence({
      session: workSession({ metadata: { participantCount: 2 } }),
      turn,
      runtimeEvents: [event("start", "turn.started", turn.startedAt), terminalEvent(turn)],
      usageRecords: [],
      consent: consent(),
    })).toThrow(/all-participant/);
    expect(() => projectDesktopWorkEvidence({
      session: workSession(),
      turn,
      runtimeEvents: [],
      usageRecords: [],
      consent: { ...consent(), scope: "transcript" as "work_process_and_artifacts" },
    })).toThrow(/process-and-artifact/);
  });

  test("correlates automatic environment lifecycle to the stable Agent turn receipt", () => {
    const turn = completedTurn();
    const projected = projectDesktopWorkEvidence({
      session: workSession(),
      turn,
      runtimeEvents: [
        event("start", "turn.started", turn.startedAt),
        {
          ...event("sandbox-create", "workspace_action_result", "2026-08-04T12:00:00.100Z"),
          action: "sandbox_create",
          status: "completed",
          data: { workspaceToolCallId: "sandbox-lifecycle" },
        },
        terminalEvent(turn),
      ],
      usageRecords: [],
      consent: consent(),
    });
    const turnReceiptHash = projected.sanitizedTrace.steps.find((step) =>
      step.action === "turn_started"
    )?.receiptHash;
    expect(projected.sanitizedTrace.steps).toContainEqual(expect.objectContaining({
      layer: "environment",
      action: "environment_created",
      parentReceiptHash: turnReceiptHash,
    }));
    expect(projected.sanitizedTrace.incompleteReasons).not.toContain(
      "uncorrelated_environment_step",
    );
  });

  test("rejects evidence projection after explicit consent expiry", () => {
    const turn = completedTurn();
    expect(() => projectDesktopWorkEvidence({
      session: workSession(),
      turn,
      runtimeEvents: [event("start", "turn.started", turn.startedAt), terminalEvent(turn)],
      usageRecords: [],
      consent: { ...consent(), expiresAt: "2026-08-04T12:00:02.750Z" },
      projectedAt: "2026-08-04T12:00:03.000Z",
    })).toThrow(/consent expired/);
  });
});

async function temporaryStore(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "openpond-work-evidence-"));
  temporaryDirectories.push(directory);
  return directory;
}

function workSession(patch: Partial<Session> = {}): Session {
  return {
    id: "work-session",
    experience: "work",
    provider: "openpond",
    modelRef: { providerId: "openpond", modelId: "openpond-chat" },
    openPondCommandAccessMode: "disabled",
    title: "Evidence Work",
    appId: null,
    appName: null,
    workspaceKind: "sandbox",
    workspaceId: "mutable-sandbox-id",
    workspaceName: "Work sandbox",
    cwd: null,
    codexThreadId: null,
    createdAt: "2026-08-04T12:00:00.000Z",
    updatedAt: "2026-08-04T12:00:02.500Z",
    status: "idle",
    pinned: false,
    archived: false,
    order: 0,
    metadata: {},
    ...patch,
  };
}

function completedTurn(patch: Partial<Turn> = {}): Turn {
  return {
    id: "work-turn",
    sessionId: "work-session",
    providerTurnId: "provider-turn-private",
    modelRef: { providerId: "openpond", modelId: "openpond-chat" },
    prompt: "secret prompt",
    startedAt: "2026-08-04T12:00:00.000Z",
    completedAt: "2026-08-04T12:00:02.500Z",
    status: "completed",
    error: null,
    metadata: {},
    createImproveRun: null,
    profileSnapshot: null,
    ...patch,
  };
}

function consent(): DesktopWorkEvidenceConsent {
  return {
    schemaVersion: "openpond.desktopWorkEvidenceConsent.v1",
    status: "granted",
    scope: "work_process_and_artifacts",
    grantedAt: "2026-08-04T11:59:00.000Z",
    policyVersion: "openpond.work-evidence-policy.v1",
    ownershipScope: "personal",
    workspaceId: null,
    participantPolicy: "creator_only",
    expiresAt: null,
  };
}

async function managedOutput(storeDir: string, turn: Turn) {
  const bytes = Buffer.from("verified output", "utf8");
  const target = path.join(storeDir, "work", "outputs", "work-session", "001-output.txt");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
  return FileOutputRefSchema.parse({
    kind: "file",
    id: "output",
    title: "output.txt",
    contentType: "text/plain",
    sizeBytes: bytes.byteLength,
    sha256: sha256(bytes),
    sourceTaskId: "work-session",
    sourceTurnId: turn.id,
    revision: 1,
    createdAt: "2026-08-04T12:00:01.800Z",
    location: { kind: "local", path: target, deviceId: "device-private" },
    validation: [{
      kind: "test",
      status: "passed",
      label: "private validation label",
      detail: "private validation detail",
    }],
  });
}

function completedEvents(output: Awaited<ReturnType<typeof managedOutput>>): RuntimeEvent[] {
  return [
    event("start", "turn.started", "2026-08-04T12:00:00.000Z"),
    {
      ...event("reasoning", "assistant.reasoning.delta", "2026-08-04T12:00:00.100Z"),
      output: "hidden chain of thought",
    },
    {
      ...event("tool-start", "tool.started", "2026-08-04T12:00:00.200Z"),
      action: "sandbox_exec",
      status: "started",
      args: { command: "contains private arguments" },
      data: { toolCallId: "raw-agent-call-id" },
    },
    {
      ...event("environment-start", "workspace_action", "2026-08-04T12:00:00.300Z"),
      action: "sandbox_exec",
      status: "started",
      data: { workspaceToolCallId: "raw-environment-call-id" },
    },
    {
      ...event("environment-complete", "workspace_action_result", "2026-08-04T12:00:00.900Z"),
      action: "sandbox_exec",
      status: "completed",
      output: "private command output",
      data: {
        workspaceToolCallId: "raw-environment-call-id",
        exitCode: 0,
        cpuTimeMs: 420,
        memoryPeakBytes: 67_108_864,
        workspaceToolTiming: { startedAtMs: 100, completedAtMs: 700 },
        outputRef: output,
      },
    },
    {
      ...event("tool-complete", "tool.completed", "2026-08-04T12:00:01.000Z"),
      action: "sandbox_exec",
      status: "completed",
      output: "private tool output",
      data: { toolCallId: "raw-agent-call-id", outputRef: output },
    },
    terminalEvent(completedTurn()),
  ];
}

function terminalEvent(turn: Turn): RuntimeEvent {
  return {
    ...event("terminal", turn.status === "completed"
      ? "turn.completed"
      : turn.status === "failed"
      ? "turn.failed"
      : "turn.interrupted", turn.completedAt!),
    status: turn.status === "completed" ? "completed" : "failed",
    error: turn.error ?? undefined,
  };
}

function event(id: string, name: RuntimeEvent["name"], timestamp: string): RuntimeEvent {
  return {
    id,
    sessionId: "work-session",
    turnId: "work-turn",
    name,
    timestamp,
    source: "server",
  };
}
