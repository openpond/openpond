import path from "node:path";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { z } from "zod";
import {
  contentHash,
  sha256,
  ImmutableArtifactRefSchema,
} from "@openpond/harness";
import {
  FileOutputRefSchema,
  WORK_OUTPUT_MAX_BYTES,
  type RuntimeEvent,
  type FileOutputRef,
} from "@openpond/contracts";
/** The private evaluator resolves only an actual sealed case's canonical saved
 * outputs. Caller paths, unsaved scratch and newer revisions supply no evidence. */
export async function readLocalProfileArtifacts(input: {
  storeDir?: string;
  attempt: {
    profileNative?: {
      sessionId: string;
      turnId: string;
      traceHash: string;
    } | null;
    artifactRefs?: unknown;
  };
  events(turnId: string): Promise<RuntimeEvent[]>;
  authorize(): Promise<void>;
  signal?: AbortSignal;
  readManaged?: (
    output: FileOutputRef,
    signal?: AbortSignal,
  ) => Promise<Buffer>;
}) {
  const native = input.attempt.profileNative,
    refs = z
      .array(ImmutableArtifactRefSchema)
      .max(16)
      .parse(input.attempt.artifactRefs ?? []);
  if (!refs.length) return [];
  if (!native || !input.storeDir)
    throw new Error("The actual retained artifact owner is unavailable.");
  await input.authorize();
  const events = await input.events(native.turnId);
  if (
    contentHash(events) !== native.traceHash ||
    events.some(
      (event) =>
        event.sessionId !== native.sessionId || event.turnId !== native.turnId,
    )
  )
    throw new Error(
      "The saved artifacts differ from their actual retained case trace.",
    );
  const artifacts = [];
  let totalBytes = 0;
  for (const ref of refs) {
    const matches = events
      .filter(
        (event) =>
          (event.action === "work_output_save" ||
            event.action === "sandbox_save_output") &&
          event.status === "completed",
      )
      .flatMap((event) => {
        const parsed = z
          .object({ outputRef: FileOutputRefSchema })
          .passthrough()
          .safeParse(event.data);
        return parsed.success ? [parsed.data.outputRef] : [];
      })
      .filter(
        (output) =>
          `${native.sessionId}/${output.id}/${output.revision}/${output.title}` ===
            ref.id &&
          output.sourceTaskId === native.sessionId &&
          output.sourceTurnId === native.turnId &&
          output.sha256 === ref.contentHash &&
          output.sizeBytes === ref.sizeBytes &&
          output.contentType === ref.mediaType,
      );
    if (matches.length !== 1)
      throw new Error(
        "The selected artifact has no unique actual saved output.",
      );
    const output = matches[0]!;
    if (
      (output.location.kind !== "local" &&
        (output.location.kind !== "managed" || !input.readManaged)) ||
      output.sizeBytes > WORK_OUTPUT_MAX_BYTES
    )
      throw new Error(
        "The retained artifact has no supported local byte owner.",
      );
    if ((totalBytes += output.sizeBytes) > 20000000)
      throw new Error(
        "The retained artifacts exceed their aggregate grading byte limit.",
      );
    await input.authorize();
    input.signal?.throwIfAborted();
    let bytes: Buffer;
    if (output.location.kind === "managed")
      bytes = await input.readManaged!(output, input.signal);
    else if (output.location.kind === "local") {
      const root = await realpath(path.join(input.storeDir, "work", "outputs"));
      const actual = await realpath(output.location.path);
      if (!actual.startsWith(`${root}${path.sep}`))
        throw new Error("The artifact escaped canonical output storage.");
      const file = await open(
        actual,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size !== output.sizeBytes)
          throw new Error("The artifact bytes changed.");
        bytes = await file.readFile();
      } finally {
        await file.close();
      }
    } else throw new Error("The saved artifact has no admitted byte owner.");
    if (bytes.length !== output.sizeBytes || sha256(bytes) !== output.sha256)
      throw new Error("The artifact bytes differ from their sealed receipt.");
    await input.authorize();
    artifacts.push({
      reference: ref,
      title: output.title,
      contentType: output.contentType,
      base64: bytes.toString("base64"),
      ...(output.contentType.startsWith("text/") ||
      output.contentType === "application/json"
        ? { text: new TextDecoder("utf8", { fatal: true }).decode(bytes) }
        : {}),
    });
  }
  await input.authorize();
  return artifacts;
}
