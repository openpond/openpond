import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { setPriority } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export type RecordedFrame = { file: string; atSeconds: number; browserTimestamp: number | null };

/** One decoder, one current JPEG and bounded pipe backpressure. Thousands of
 * concat image segments can otherwise retain thousands of decoder contexts. */
export async function encodeRecording(frameDirectory: string, frames: RecordedFrame[], durationSeconds: number, output: string) {
  if (!frames.length || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 1801)
    throw new Error("Recording has no bounded frame timeline.");
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i]!;
    if (!/^frame-\d+\.jpg$/.test(frame.file) || !Number.isFinite(frame.atSeconds) || frame.atSeconds < 0
      || frame.atSeconds > durationSeconds || (i > 0 && frame.atSeconds < frames[i - 1]!.atSeconds))
      throw new Error("Recording frame timeline is invalid.");
  }
  async function* jpegStream() {
    let index = 0, loaded = -1, jpeg: Buffer | undefined;
    for (let tick = 0; tick < Math.ceil(durationSeconds * 30); tick++) {
      while (index + 1 < frames.length && frames[index + 1]!.atSeconds <= tick / 30) index++;
      if (loaded !== index) {
        jpeg = await readFile(path.join(frameDirectory, frames[index]!.file));
        loaded = index;
      }
      yield jpeg!;
    }
  }
  const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-n",
    "-threads", "1", "-filter_threads", "1", "-f", "image2pipe", "-framerate", "30", "-c:v", "mjpeg", "-i", "pipe:0",
    "-an", "-c:v", "libx264", "-threads", "1", "-preset", "veryfast", "-tune", "zerolatency", "-crf", "18",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart", output], { stdio: ["pipe", "ignore", "pipe"] });
  if (child.pid) setPriority(child.pid, 15);
  let errors = "";
  child.stderr.on("data", (chunk: Buffer) => { errors = (errors + chunk.toString()).slice(-8000); });
  const completed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`Video encoding failed (${code}): ${errors}`)));
  });
  try {
    await Promise.all([pipeline(Readable.from(jpegStream()), child.stdin), completed]);
  } catch (error) {
    child.kill("SIGTERM");
    await completed.catch(() => {});
    throw error;
  }
}
