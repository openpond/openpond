import { z } from "zod";
import type { FileOutputRef, Session } from "@openpond/contracts";
import type { DeviceLocalOwner } from "./local-scope.js";
import { deviceOwnsLocalSession } from "./local-scope.js";

export async function uploadRemoteArtifact(input: {
  payload: unknown; owner: DeviceLocalOwner; uploadOrigins: string[];
  session(id: string): Promise<Session | null>;
  outputs(session: Session): Promise<FileOutputRef[]>;
  read(session: Session, outputId: string): Promise<{ outputRef: FileOutputRef; contentsBase64: string }>;
  stillCurrent(): boolean;
}) {
  const request = z.object({ taskId: z.string(), artifactId: z.string(), uploadUrl: z.string().url(),
    maxBytes: z.number().int().positive().max(26_214_400) }).strict().parse(input.payload);
  const url = new URL(request.uploadUrl);
  if (url.protocol !== "https:" || url.username || url.password || !input.uploadOrigins.includes(url.origin)) throw new Error("remote_artifact_upload_origin_denied");
  const session = await input.session(request.taskId);
  if (!session || !deviceOwnsLocalSession(session, input.owner)) throw new Error("remote_artifact_not_owned");
  const output = (await input.outputs(session)).find(output => output.id === request.artifactId);
  if (!output || output.sourceTaskId !== session.id || output.sizeBytes > request.maxBytes) throw new Error("remote_artifact_unavailable_or_too_large");
  const saved = await input.read(session, output.id);
  if (saved.outputRef.sha256 !== output.sha256 || saved.outputRef.sizeBytes !== output.sizeBytes || !input.stillCurrent()) throw new Error("remote_artifact_authority_changed");
  const bytes = Buffer.from(saved.contentsBase64, "base64");
  if (bytes.byteLength > request.maxBytes || bytes.byteLength !== output.sizeBytes) throw new Error("remote_artifact_size_changed");
  const uploaded = await fetch(url, { method: "PUT", body: bytes, headers: { "Content-Type": output.contentType },
    redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!uploaded.ok) throw new Error("remote_artifact_upload_failed");
  if (!input.stillCurrent()) throw new Error("remote_artifact_authority_changed");
  return { artifactId: output.id };
}
