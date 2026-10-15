import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CdpClient, CdpDesktopHarnessRenderer, waitForDevtoolsTarget } from "./desktop-harness/cdp.js";
import { encodeRecording, type RecordedFrame } from "./desktop-harness/recording-encoder.js";

type ScreencastFrame = { data: string; sessionId: number; metadata: { timestamp?: number } };

function options(args: string[]) {
  let port = 9333, durationSeconds = 600, output = "", encodeExisting = "", encodeVideo = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--help") {
      console.log("usage: pnpm exec tsx scripts/desktop-harness-record.ts --output <raw.mp4> [--port 9333] [--duration-seconds 600] [--encode]\n       pnpm exec tsx scripts/desktop-harness-record.ts --encode-recording <recording.json> --output <raw.mp4>\nRecords only the existing dark 1920×1080 OpenPond page. Type q and Enter or send SIGINT to finish early. Capture retains original JPEG frames and timestamps; encoding is opt-in so it can use a separately scheduled resource window.");
      process.exit(0);
    }
    if (flag === "--encode") { encodeVideo = true; continue; }
    const value = args[++i];
    if (!value) throw new Error(`Missing value for ${flag}.`);
    if (flag === "--port") port = Number(value);
    else if (flag === "--duration-seconds") durationSeconds = Number(value);
    else if (flag === "--output") output = path.resolve(value);
    else if (flag === "--encode-recording") encodeExisting = path.resolve(value);
    else throw new Error(`Unknown option ${flag}.`);
  }
  if (!output.endsWith(".mp4")) throw new Error("Choose an .mp4 output path.");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid DevTools port.");
  if (!Number.isFinite(durationSeconds) || durationSeconds < 1 || durationSeconds > 1800) throw new Error("Recording duration must be 1–1800 seconds.");
  return { port, durationSeconds, output, encodeExisting, encodeVideo };
}

async function record() {
  const args = options(process.argv.slice(2));
  if (args.encodeExisting) {
    const recording = JSON.parse(await readFile(args.encodeExisting, "utf8")) as { schemaVersion: string; frames: RecordedFrame[]; durationSeconds: number };
    if (recording.schemaVersion !== "openpond.desktopRecording.v1" || !Array.isArray(recording.frames)) throw new Error("Choose a retained desktop recording manifest.");
    await encodeRecording(path.dirname(args.encodeExisting), recording.frames, recording.durationSeconds, args.output);
    console.log(JSON.stringify({ output: args.output, width: 1920, height: 1080, fps: 30 }));
    return;
  }
  const target = await waitForDevtoolsTarget(args.port, 15000, (item) => item.type === "page" && item.title === "OpenPond App");
  const pageUrl = new URL(target.url);
  pageUrl.search = "";
  pageUrl.hash = "";
  const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
  const renderer = new CdpDesktopHarnessRenderer(cdp, path.dirname(args.output), 10000);
  const frameDirectory = args.output.replace(/\.mp4$/, "-frames");
  const frames: RecordedFrame[] = [];
  let writing = Promise.resolve(), failure: unknown;
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  const start = Date.now();
  const onInput = (chunk: Buffer) => { if (chunk.toString().trim().toLowerCase() === "q") finish(); };
  const onSignal = () => finish();
  let unsubscribe = () => {};
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let durationSeconds = 0;
  try {
    const viewport = await renderer.evaluate<{ width: number; height: number; theme: string }>("({width:innerWidth,height:innerHeight,theme:document.documentElement.dataset.theme})");
    if (viewport.width !== 1920 || viewport.height !== 1080 || viewport.theme !== "dark") throw new Error("The existing OpenPond page must be dark at 1920×1080 before recording.");
    await mkdir(path.dirname(args.output), { recursive: true });
    await mkdir(frameDirectory, { recursive: false });
    await writeFile(path.join(frameDirectory, "recording.json"), JSON.stringify({
      schemaVersion: "openpond.desktopRecording.v1", state: "capturing", startedAt: new Date(start).toISOString(),
      pageUrl: pageUrl.toString(), viewport, output: args.output,
    }, null, 2));
    unsubscribe = cdp.on<ScreencastFrame>("Page.screencastFrame", (frame) => {
      const atSeconds = (Date.now() - start) / 1000;
      writing = writing.then(async () => {
        const file = `frame-${String(frames.length).padStart(6, "0")}.jpg`;
        await writeFile(path.join(frameDirectory, file), Buffer.from(frame.data, "base64"));
        const recorded = { file, atSeconds, browserTimestamp: frame.metadata.timestamp ?? null };
        frames.push(recorded);
        await appendFile(path.join(frameDirectory, "frame-times.jsonl"), `${JSON.stringify(recorded)}\n`);
        await cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId });
      }).catch((error) => { failure = error; finish(); });
    });
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    process.stdin.on("data", onInput);
    process.stdin.resume();
    timeout = setTimeout(finish, args.durationSeconds * 1000);
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 90, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
    console.log(`Recording the existing OpenPond page; up to ${args.durationSeconds}s. Type q then Enter to finish.`);
    await finished;
    durationSeconds = (Date.now() - start) / 1000;
    await cdp.send("Page.stopScreencast");
    unsubscribe();
    await writing;
    if (failure) throw failure;
    if (!frames.length) throw new Error("No screencast frames received; no video was fabricated.");
    const timeline = frames.flatMap((frame, index) => [
      `file '${frame.file}'`,
      `duration ${Math.max(0.001, (frames[index + 1]?.atSeconds ?? durationSeconds) - frame.atSeconds).toFixed(6)}`,
    ]);
    timeline.push(`file '${frames.at(-1)!.file}'`);
    const manifest = path.join(frameDirectory, "frames.ffconcat");
    await writeFile(manifest, `ffconcat version 1.0\n${timeline.join("\n")}\n`);
    await writeFile(path.join(frameDirectory, "recording.json"), JSON.stringify({
      schemaVersion: "openpond.desktopRecording.v1", state: "captured", startedAt: new Date(start).toISOString(), durationSeconds,
      pageUrl: pageUrl.toString(), viewport, frames, output: args.output,
    }, null, 2));
    console.log(`Retained ${frames.length} original frames and timestamps.${args.encodeVideo ? " Encoding with one input and output thread…" : " Encoding deferred to a separate resource window."}`);
    if (args.encodeVideo) await encodeRecording(frameDirectory, frames, durationSeconds, args.output);
    console.log(JSON.stringify({ output: args.encodeVideo ? args.output : null, originalFrames: frameDirectory, frames: frames.length, durationSeconds, width: 1920, height: 1080, fps: 30 }));
  } finally {
    if (timeout) clearTimeout(timeout);
    unsubscribe();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.stdin.off("data", onInput);
    process.stdin.pause();
    renderer.close();
  }
}

void record().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
