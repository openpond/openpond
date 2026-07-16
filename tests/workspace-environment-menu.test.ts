import { describe, expect, test } from "vitest";

import {
  formatIdleTimeout,
  sandboxChangedFileCount,
  sandboxChangeLabel,
  sandboxRuntimePolicyLabel,
} from "../apps/web/src/components/chat/WorkspaceEnvironmentMenu";
import { sandboxResumeArgs } from "../apps/web/src/components/chat/workspace-environment-actions";
import type { SandboxRecord } from "../apps/web/src/lib/sandbox-types";

describe("workspace environment menu", () => {
  test("summarizes sandbox git status without reporting unknown sandbox state as clean", () => {
    expect(sandboxChangedFileCount(" M README.md\n?? src/new.ts\n")).toBe(2);

    expect(sandboxChangeLabel({ status: "idle", changedFiles: 0, error: null })).toBe("Sandbox changes unknown");
    expect(sandboxChangeLabel({ status: "loading", changedFiles: 0, error: null })).toBe("Checking sandbox changes");
    expect(sandboxChangeLabel({ status: "error", changedFiles: 0, error: "sandbox_not_ready" })).toBe(
      "Sandbox status unavailable",
    );
    expect(sandboxChangeLabel({ status: "ready", changedFiles: 0, error: null })).toBe("Sandbox clean");
    expect(sandboxChangeLabel({ status: "ready", changedFiles: 1, error: null })).toBe(
      "1 sandbox changed file",
    );
    expect(sandboxChangeLabel({ status: "ready", changedFiles: 2, error: null })).toBe(
      "2 sandbox changed files",
    );
  });

  test("builds explicit runtime resume args with bounded cost controls", () => {
    expect(
      sandboxResumeArgs({
        id: "sandbox_123",
        runtimeId: "runtime_123",
        teamId: "team_123",
        projectId: "project_123",
        state: "stopped",
      }),
    ).toEqual({
      teamId: "team_123",
      projectId: "project_123",
      runtime: { runtimeId: "runtime_123" },
      visibility: "team",
      budget: { maxUsd: "0.05" },
      quotas: {
        idleTimeoutSeconds: 900,
        maxSpendUsd: "0.05",
      },
      metadata: {
        source: "openpond-app-environment-menu-sandbox-resume",
        resumeSandboxId: "sandbox_123",
        previousState: "stopped",
      },
    });
  });

  test("summarizes sandbox idle cleanup and cost policy", () => {
    expect(formatIdleTimeout(900)).toBe("15 min");
    expect(formatIdleTimeout(3600)).toBe("1 hr");
    expect(sandboxRuntimePolicyLabel(null)).toBe("Loading sandbox policy");

    expect(
      sandboxRuntimePolicyLabel(
        sandboxRecord({
          quotas: {
            maxDurationSeconds: 0,
            idleTimeoutSeconds: 900,
            maxCommands: 0,
            maxOpenPorts: 0,
            maxSnapshots: 0,
            maxSpendUsd: "0.05",
          },
          reservation: {
            status: "reserved",
            reservedUsd: "0.05",
            capturedUsd: "0",
          },
        }),
      ),
    ).toBe("Auto-stop after 15 min idle · cap $0.05 · reservation active $0.05");

    expect(
      sandboxRuntimePolicyLabel(
        sandboxRecord({
          state: "stopped",
          quotas: {
            maxDurationSeconds: 0,
            idleTimeoutSeconds: 600,
            maxCommands: 0,
            maxOpenPorts: 0,
            maxSnapshots: 0,
            maxSpendUsd: "0.05",
          },
          receipts: [
            {
              reason: "idle_timeout",
              totalUsd: "0.011696",
              createdAt: "2026-07-05T12:00:00.000Z",
            },
          ],
        }),
      ),
    ).toBe("Auto-stop after 10 min idle · cap $0.05 · stopped by idle timeout · charged $0.0117");
  });
});

function sandboxRecord(overrides: {
  state?: SandboxRecord["state"];
  quotas?: SandboxRecord["quotas"];
  reservation?: Partial<SandboxRecord["reservation"]>;
  receipts?: Array<Partial<SandboxRecord["receipts"][number]>>;
} = {}): SandboxRecord {
  return {
    id: "sandbox_123",
    state: overrides.state ?? "running",
    runtimeDriver: "remote-firecracker",
    repo: null,
    teamId: "team_123",
    projectId: "project_123",
    agentId: null,
    visibility: "team",
    ownerUserId: "user_123",
    billingAccountId: "billing_123",
    resources: { cpu: 1, memoryGb: 2, diskGb: 10 },
    budget: { maxUsd: "0.05" },
    quotas: overrides.quotas,
    reservation: {
      id: "reservation_123",
      status: "reserved",
      reservedUsd: "0.05",
      capturedUsd: "0",
      createdAt: "2026-07-05T11:00:00.000Z",
      updatedAt: "2026-07-05T11:00:00.000Z",
      ...overrides.reservation,
    },
    commands: [],
    previewPorts: [],
    receipts: (overrides.receipts ?? []).map((receipt, index) => ({
      id: `receipt_${index}`,
      sandboxId: "sandbox_123",
      reservationId: "reservation_123",
      status: "captured",
      reason: "stopped",
      totalUsd: "0",
      durationSeconds: 0,
      lineItems: [],
      mpp: {
        mode: "simulated_poc",
        settlementRail: "tempo_usdce",
        receiptRef: `receipt_ref_${index}`,
      },
      createdAt: "2026-07-05T11:00:00.000Z",
      ...receipt,
    })),
    logs: [],
    metadata: {},
    createdAt: "2026-07-05T11:00:00.000Z",
    updatedAt: "2026-07-05T11:00:00.000Z",
    startedAt: "2026-07-05T11:00:00.000Z",
    stoppedAt: overrides.state === "stopped" ? "2026-07-05T12:00:00.000Z" : null,
    deletedAt: null,
  };
}
