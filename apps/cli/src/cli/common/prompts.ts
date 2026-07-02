import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

export async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks)
    .toString("utf8")
    .replace(/\r?\n$/, "");
}

export function readMaskedLine(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stderr = process.stderr;
    let value = "";
    const wasRaw = stdin.isRaw;

    function cleanup() {
      stdin.off("data", onData);
      if (stdin.setRawMode) stdin.setRawMode(wasRaw);
      stdin.pause();
      stderr.write("\n");
    }

    function onData(chunk: Buffer | string) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      for (const byte of buffer) {
        if (byte === 3) {
          cleanup();
          reject(new Error("secret prompt cancelled"));
          return;
        }
        if (byte === 13 || byte === 10) {
          cleanup();
          resolve(value);
          return;
        }
        if (byte === 127 || byte === 8) {
          if (value.length > 0) {
            value = value.slice(0, -1);
            stderr.write("\b \b");
          }
          continue;
        }
        value += Buffer.from([byte]).toString("utf8");
        stderr.write("*");
      }
    }

    stderr.write(prompt);
    stdin.resume();
    if (stdin.setRawMode) stdin.setRawMode(true);
    stdin.on("data", onData);
  });
}

export async function promptConfirm(
  question: string,
  defaultValue = false
): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    const suffix = defaultValue ? "[Y/n]" : "[y/N]";
    const answer = (await rl.question(`${question} ${suffix} `))
      .trim()
      .toLowerCase();
    if (!answer) return defaultValue;
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

export async function promptForPath(defaultPath: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    const answer = (
      await rl.question(`Local path (default: ${defaultPath}): `)
    ).trim();
    return answer || defaultPath;
  } finally {
    rl.close();
  }
}
