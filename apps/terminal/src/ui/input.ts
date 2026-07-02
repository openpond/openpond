import type { ReadStream } from "node:tty";

export type KeyHandler = (key: string) => void;

export class RawInput {
  private readonly input: ReadStream;
  private readonly onKey: KeyHandler;
  private previousRawMode = false;
  private dataHandler: ((chunk: Buffer) => void) | null = null;

  constructor(input: ReadStream, onKey: KeyHandler) {
    this.input = input;
    this.onKey = onKey;
  }

  start(): void {
    this.previousRawMode = this.input.isRaw ?? false;
    this.input.setRawMode(true);
    this.input.resume();
    this.dataHandler = (chunk) => {
      for (const key of decodeKeys(chunk)) this.onKey(key);
    };
    this.input.on("data", this.dataHandler);
  }

  stop(): void {
    if (this.dataHandler) this.input.off("data", this.dataHandler);
    this.dataHandler = null;
    this.input.setRawMode(this.previousRawMode);
  }
}

export function decodeKeys(chunk: Buffer): string[] {
  const text = chunk.toString("utf8");
  const keys: string[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    const next = text[i + 1];
    if (char === "\x1b") {
      const sequence = readEscapeSequence(text, i);
      keys.push(sequence.key);
      i = sequence.end;
      continue;
    }
    if (char === "\x03") keys.push("ctrl+c");
    else if (char === "\x04") keys.push("ctrl+d");
    else if (char === "\x0c") keys.push("ctrl+l");
    else if (char === "\x01") keys.push("ctrl+a");
    else if (char === "\x05") keys.push("ctrl+e");
    else if (char === "\x0b") keys.push("ctrl+k");
    else if (char === "\x15") keys.push("ctrl+u");
    else if (char === "\x7f" || char === "\b") keys.push("backspace");
    else if (char === "\r" || char === "\n") keys.push("enter");
    else if (char >= " " || (char && next)) keys.push(char);
  }
  return keys;
}

function readEscapeSequence(text: string, start: number): { key: string; end: number } {
  const rest = text.slice(start);
  if (rest.startsWith("\x1b\r") || rest.startsWith("\x1b\n")) return { key: "alt+enter", end: start + 1 };
  if (rest.startsWith("\x1b[A")) return { key: "up", end: start + 2 };
  if (rest.startsWith("\x1b[B")) return { key: "down", end: start + 2 };
  if (rest.startsWith("\x1b[C")) return { key: "right", end: start + 2 };
  if (rest.startsWith("\x1b[D")) return { key: "left", end: start + 2 };
  if (rest.startsWith("\x1b[H") || rest.startsWith("\x1b[1~") || rest.startsWith("\x1bOH")) {
    return { key: "home", end: start + (rest.startsWith("\x1b[1~") ? 3 : 2) };
  }
  if (rest.startsWith("\x1b[F") || rest.startsWith("\x1b[4~") || rest.startsWith("\x1bOF")) {
    return { key: "end", end: start + (rest.startsWith("\x1b[4~") ? 3 : 2) };
  }
  if (rest.startsWith("\x1b[3~")) return { key: "delete", end: start + 3 };
  if (rest.startsWith("\x1b[5~")) return { key: "pageup", end: start + 3 };
  if (rest.startsWith("\x1b[6~")) return { key: "pagedown", end: start + 3 };
  if (rest.length >= 2 && rest[1] && rest[1] >= " ") return { key: rest[1], end: start + 1 };
  return { key: "", end: start };
}
