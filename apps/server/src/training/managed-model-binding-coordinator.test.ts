import { describe, expect, it, vi } from "vitest";
import { ModelBindingSchema, type ModelBinding } from "@openpond/contracts";
import { createManagedModelBindingCoordinator } from "./managed-model-binding-coordinator.js";

const timestamp = "2026-07-19T16:00:00.000Z";

function binding(
  id: string,
  managedProjectionVersion = 1,
): ModelBinding {
  return ModelBindingSchema.parse({
    schemaVersion: "openpond.modelBinding.v1",
    id,
    profileId: "profile-qa",
    role: "chat_manual",
    roleTargetId: "chat-qa",
    modelArtifactLineageId: `lineage-${id}`,
    tasksetId: "taskset-qa",
    evaluationArtifactId: "evaluation-qa",
    status: "active",
    priorBindingId: null,
    rollbackTargetBindingId: null,
    promotedBy: "user-qa",
    promotedAt: timestamp,
    rolledBackAt: null,
    metadata: { managedProjectionVersion },
  });
}

describe("managed Model binding coordinator", () => {
  it("deactivates the prior projection before replacing local authority", async () => {
    const current = binding("binding-current");
    const next = binding("binding-next");
    const order: string[] = [];
    const replaceActiveModelBinding = vi.fn(async () => {
      order.push("replace");
      return { previous: current, active: next };
    });
    const activateManagedBinding = vi.fn(async () => {
      order.push("activate");
    });
    const coordinator = createManagedModelBindingCoordinator({
      store: {
        saveModelBinding: vi.fn(async (value) => value),
        replaceActiveModelBinding,
      },
      deactivateManagedBinding: vi.fn(async () => {
        order.push("deactivate");
        return 2;
      }),
      activateManagedBinding,
    });

    const result = await coordinator.replace({
      profileId: current.profileId,
      role: current.role,
      roleTargetId: current.roleTargetId,
      current,
      next,
      timestamp,
    });

    expect(order).toEqual(["deactivate", "replace", "activate"]);
    expect(result.previous?.metadata.managedProjectionVersion).toBe(2);
    expect(replaceActiveModelBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedActiveBindingId: current.id,
        next,
      }),
    );
  });

  it("persists and remotely publishes a monotonic compensation on CAS failure", async () => {
    const current = binding("binding-current", 4);
    const saved: ModelBinding[] = [];
    const reactivated: ModelBinding[] = [];
    const coordinator = createManagedModelBindingCoordinator({
      store: {
        saveModelBinding: vi.fn(async (value) => {
          saved.push(value);
          return value;
        }),
        replaceActiveModelBinding: vi.fn(async () => {
          throw new Error("binding_cas_conflict");
        }),
      },
      deactivateManagedBinding: vi.fn(async () => 5),
      reactivateManagedBinding: vi.fn(async (value) => {
        reactivated.push(value);
        return 6;
      }),
    });

    await expect(
      coordinator.replace({
        profileId: current.profileId,
        role: current.role,
        roleTargetId: current.roleTargetId,
        current,
        next: binding("binding-next"),
        timestamp,
      }),
    ).rejects.toThrow("binding_cas_conflict");

    expect(
      saved.map((value) => value.metadata.managedProjectionVersion),
    ).toEqual([5, 6]);
    expect(reactivated).toHaveLength(1);
    expect(reactivated[0]?.metadata.managedProjectionVersion).toBe(5);
  });

  it("fails closed before the local binding changes when remote deactivation fails", async () => {
    const current = binding("binding-current");
    const replaceActiveModelBinding = vi.fn();
    const activateManagedBinding = vi.fn();
    const coordinator = createManagedModelBindingCoordinator({
      store: {
        saveModelBinding: vi.fn(async (value) => value),
        replaceActiveModelBinding,
      },
      deactivateManagedBinding: vi.fn(async () => {
        throw new Error("managed_projection_unavailable");
      }),
      activateManagedBinding,
    });

    await expect(
      coordinator.replace({
        profileId: current.profileId,
        role: current.role,
        roleTargetId: current.roleTargetId,
        current,
        next: binding("binding-next"),
        timestamp,
      }),
    ).rejects.toThrow("managed_projection_unavailable");

    expect(replaceActiveModelBinding).not.toHaveBeenCalled();
    expect(activateManagedBinding).not.toHaveBeenCalled();
  });

  it("keeps the prior projection inactive when next activation needs reconciliation", async () => {
    const current = binding("binding-current");
    const next = binding("binding-next");
    const reactivateManagedBinding = vi.fn();
    const coordinator = createManagedModelBindingCoordinator({
      store: {
        saveModelBinding: vi.fn(async (value) => value),
        replaceActiveModelBinding: vi.fn(async () => ({
          previous: current,
          active: next,
        })),
      },
      deactivateManagedBinding: vi.fn(async () => 2),
      reactivateManagedBinding,
      activateManagedBinding: vi.fn(async () => {
        throw new Error("managed_projection_target_not_ready");
      }),
    });

    await expect(
      coordinator.replace({
        profileId: current.profileId,
        role: current.role,
        roleTargetId: current.roleTargetId,
        current,
        next,
        timestamp,
      }),
    ).resolves.toMatchObject({
      previous: {
        id: current.id,
        metadata: { managedProjectionVersion: 2 },
      },
    });

    expect(reactivateManagedBinding).not.toHaveBeenCalled();
  });
});
