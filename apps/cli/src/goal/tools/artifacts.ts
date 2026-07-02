import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

import { createGoalEvent, recordGoalEvent } from "../events";
import { redactString } from "../redaction";
import type { HostedGoalClient } from "../state/hosted";
import type { GoalStateAdapter } from "../state/adapter";
import type { GoalArtifact, GoalArtifactRef } from "../types";

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "artifact";
}

export function createGoalArtifact(input: {
  goalId: string;
  iterationId?: string | null;
  kind: GoalArtifact["kind"];
  name: string;
  mimeType?: string;
  content: string;
}): GoalArtifact {
  const content = redactString(input.content);
  return {
    id: `artifact_${randomUUID()}`,
    goalId: input.goalId,
    iterationId: input.iterationId ?? null,
    kind: input.kind,
    name: input.name,
    mimeType: input.mimeType ?? "text/plain",
    content,
    bytes: Buffer.byteLength(content, "utf-8"),
    createdAt: new Date().toISOString(),
  };
}

export async function recordGoalArtifact(params: {
  artifact: GoalArtifact;
  workspace?: string | null;
  storageRoot?: string | null;
  localState?: GoalStateAdapter | null;
  hostedClient?: HostedGoalClient | null;
}): Promise<GoalArtifactRef> {
  const artifact = params.artifact;
  const ref = params.hostedClient
    ? await params.hostedClient.uploadArtifact(artifact)
    : await writeLocalArtifact(artifact, params.storageRoot ?? params.workspace);

  await recordGoalEvent(
    createGoalEvent({
      goalId: artifact.goalId,
      iterationId: artifact.iterationId,
      kind: "artifact.created",
      summary: `Artifact created: ${artifact.name}`,
      payload: {
        artifactRef: ref.ref,
        artifactId: ref.id,
        kind: ref.kind,
        name: ref.name,
        bytes: ref.bytes,
      },
    }),
    { localState: params.localState, hostedClient: params.hostedClient }
  );
  return ref;
}

async function writeLocalArtifact(
  artifact: GoalArtifact,
  storageRoot?: string | null
): Promise<GoalArtifactRef> {
  const root = storageRoot || process.cwd();
  const dir = join(root, ".openpond", "goals", artifact.goalId, "artifacts");
  await mkdir(dir, { recursive: true });
  const fileName = `${artifact.id}-${safeFileName(artifact.name)}`;
  const path = join(dir, fileName);
  await writeFile(path, artifact.content, "utf-8");
  const relativeRef = `.openpond/goals/${artifact.goalId}/artifacts/${fileName}`;
  return {
    id: artifact.id,
    ref: root === os.homedir() ? `~/${relativeRef}` : relativeRef,
    kind: artifact.kind,
    name: artifact.name,
    mimeType: artifact.mimeType,
    bytes: artifact.bytes,
  };
}
