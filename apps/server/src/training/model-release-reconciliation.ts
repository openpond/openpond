import { nextCreateImproveRunRevision } from "@openpond/contracts";
import type { SqliteStore } from "../store/store.js";

export async function updateModelCreateImproveRelease(input: {
  store: SqliteStore;
  modelId: string;
  jobId: string;
  artifactId: string;
  status: "released" | "rejected" | "rolled_back";
  receiptId: string;
  timestamp: string;
  reason: string | null;
}): Promise<void> {
  const runs = await input.store.listCreateImproveRuns({
    targetKind: "model",
    limit: 500,
  });
  for (const run of runs) {
    if (
      run.target.kind !== "model"
      || (
        run.target.trainingJobId !== input.jobId
        && run.target.artifactId !== input.artifactId
      )
    ) {
      continue;
    }
    const candidate = run.candidates.find((item) =>
      item.target.kind === "model"
      && (
        item.target.trainingJobId === input.jobId
        || item.artifactRefs.includes(input.artifactId)
      ));
    const candidates = candidate
      ? run.candidates.map((item) =>
          item.id === candidate.id
            ? {
                ...item,
                status: input.status === "released"
                  ? "accepted" as const
                  : input.status === "rejected"
                    ? "rejected" as const
                    : item.status,
                updatedAt: input.timestamp,
              }
            : item)
      : run.candidates;
    let staged = run;
    if (input.status === "released" && staged.state !== "released") {
      if (staged.state === "ready") {
        staged = nextCreateImproveRunRevision(staged, {
          state: "awaiting_promotion",
          updatedAt: input.timestamp,
        });
      }
      if (staged.state === "awaiting_promotion") {
        staged = nextCreateImproveRunRevision(staged, {
          state: "reconciling_release",
          updatedAt: input.timestamp,
        });
      }
      if (staged.state !== "reconciling_release") {
        throw new Error(`Model promotion cannot release a run from ${staged.state}.`);
      }
      staged = nextCreateImproveRunRevision(staged, {
        state: "released",
        updatedAt: input.timestamp,
      });
    } else if (input.status === "rejected" && staged.state !== "rejected") {
      if (staged.state === "ready") {
        staged = nextCreateImproveRunRevision(staged, {
          state: "awaiting_promotion",
          updatedAt: input.timestamp,
        });
      }
      if (staged.state !== "awaiting_promotion") {
        throw new Error(`Model rejection cannot complete a run from ${staged.state}.`);
      }
      staged = nextCreateImproveRunRevision(staged, {
        state: "rejected",
        updatedAt: input.timestamp,
      });
    } else if (input.status === "rolled_back" && staged.state === "released") {
      staged = nextCreateImproveRunRevision(staged, {
        state: "ready",
        updatedAt: input.timestamp,
      });
    }
    await input.store.upsertCreateImproveRun(nextCreateImproveRunRevision(staged, {
      state: staged.state,
      candidates,
      releaseOutcome: {
        ...run.releaseOutcome,
        status: input.status,
        releaseReceiptRef: input.receiptId,
        updatedAt: input.timestamp,
      },
      externalExecutionRefs: [
        ...run.externalExecutionRefs.filter((ref) =>
          !(ref.kind === "release" && ref.id === input.receiptId)),
        {
          kind: "release",
          id: input.receiptId,
          status: input.status,
          metadata: {
            modelId: input.modelId,
            artifactId: input.artifactId,
          },
        },
      ],
      blockedReason: input.status === "rejected" ? input.reason : null,
      updatedAt: input.timestamp,
    }));
  }
}
