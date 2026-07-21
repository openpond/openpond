import {
  ModelBindingSchema,
  type ModelBinding,
  type ModelBindingRole,
} from "@openpond/contracts";
import type { SqliteStore } from "../store/store.js";

export interface ManagedModelBindingCallbacks {
  deactivateManagedBinding?: (
    binding: ModelBinding,
    sourceUpdatedAt: string,
  ) => Promise<number | null>;
  reactivateManagedBinding?: (
    binding: ModelBinding,
    sourceUpdatedAt: string,
  ) => Promise<number | null>;
  activateManagedBinding?: (binding: ModelBinding) => Promise<void>;
}

type ManagedModelBindingStore = Pick<
  SqliteStore,
  "saveModelBinding" | "replaceActiveModelBinding"
>;

export function createManagedModelBindingCoordinator(
  dependencies: ManagedModelBindingCallbacks & {
    store: ManagedModelBindingStore;
  },
) {
  async function replace(input: {
    profileId: string;
    role: ModelBindingRole;
    roleTargetId: string;
    current: ModelBinding | null;
    next: ModelBinding | null;
    timestamp: string;
  }): Promise<{ previous: ModelBinding | null }> {
    let previous = input.current;
    let deactivatedVersion: number | null = null;
    if (previous && dependencies.deactivateManagedBinding) {
      deactivatedVersion = await dependencies.deactivateManagedBinding(
        previous,
        input.timestamp,
      );
      if (deactivatedVersion) {
        previous = await dependencies.store.saveModelBinding(
          withManagedProjectionVersion(previous, deactivatedVersion),
        );
      }
    }

    try {
      await dependencies.store.replaceActiveModelBinding({
        profileId: input.profileId,
        role: input.role,
        roleTargetId: input.roleTargetId,
        expectedActiveBindingId: previous?.id ?? null,
        next: input.next,
        timestamp: input.timestamp,
      });
    } catch (error) {
      if (previous && deactivatedVersion) {
        const compensationVersion = deactivatedVersion + 1;
        await dependencies.store.saveModelBinding(
          withManagedProjectionVersion(previous, compensationVersion),
        );
        await dependencies
          .reactivateManagedBinding?.(
            withManagedProjectionVersion(previous, deactivatedVersion),
            input.timestamp,
          )
          .catch(() => undefined);
      }
      throw error;
    }

    if (input.next) {
      // The local binding is authoritative once the transaction commits.
      // Leave the old remote projection inactive if activating the new one
      // fails; the periodic reconciler will retry the new projection. Never
      // reactivate the old projection here because that would silently serve
      // a stale adapter version under the new local product identity.
      await dependencies
        .activateManagedBinding?.(input.next)
        .catch(() => undefined);
    }
    return { previous };
  }

  return { replace };
}

function withManagedProjectionVersion(
  binding: ModelBinding,
  version: number,
): ModelBinding {
  return ModelBindingSchema.parse({
    ...binding,
    metadata: {
      ...binding.metadata,
      managedProjectionVersion: version,
    },
  });
}
