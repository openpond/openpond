import { apiFetch } from "../api/core.js";
import type { SandboxPtyInput } from "./types/index.js";

export async function streamSandboxEventOutput(params: {
  sandboxApiUrl: string;
  apiKey: string;
  path: string;
}): Promise<void> {
  const response = await apiFetch(
    params.sandboxApiUrl,
    params.apiKey,
    params.path,
    { timeoutMs: 0, maxResponseBytes: 0 },
  );
  if (!response.body) {
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let separatorIndex = buffered.indexOf("\n\n");
      while (separatorIndex !== -1) {
        const event = buffered.slice(0, separatorIndex);
        buffered = buffered.slice(separatorIndex + 2);
        const output = parseProcessOutputEvent(event);
        if (output) process.stdout.write(output);
        separatorIndex = buffered.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function normalizePtyInput(
  input: string | Uint8Array | SandboxPtyInput
): SandboxPtyInput {
  if (typeof input === "string") {
    return { dataBase64: Buffer.from(input, "utf-8").toString("base64") };
  }
  if (input instanceof Uint8Array) {
    return { dataBase64: Buffer.from(input).toString("base64") };
  }
  return input;
}

function parseProcessOutputEvent(event: string): string | null {
  if (!event.includes("event: output")) {
    return null;
  }
  const dataLines = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length));
  if (dataLines.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(dataLines.join("\n")) as { output?: unknown };
    return typeof parsed.output === "string" ? parsed.output : null;
  } catch {
    return null;
  }
}
