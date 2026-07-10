import type { WriteStream } from "node:tty";
import { clearLine, hideCursor, resetCursorColor, setCursorColor, showCursor } from "./ansi.js";
import { buildFrame, type LayoutInput } from "./layout.js";
import { TranscriptLayoutCache } from "./transcript-layout-cache.js";

const CSI = "\x1b[";
const MAX_FRAME_ROWS = 10;

export class TerminalRenderer {
  private readonly output: WriteStream;
  private previousRows = 0;
  private cursorRow = 1;
  private active = false;
  private resizeHandler: (() => void) | null = null;
  private readonly transcriptLayoutCache = new TranscriptLayoutCache();

  constructor(output: WriteStream, onResize: () => void) {
    this.output = output;
    this.resizeHandler = onResize;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.output.write(`${setCursorColor("#ffffff")}${hideCursor()}`);
    if (this.resizeHandler) this.output.on("resize", this.resizeHandler);
  }

  stop(): void {
    if (!this.active) return;
    if (this.resizeHandler) this.output.off("resize", this.resizeHandler);
    this.output.write(`${this.clearPrompt()}${resetCursorColor()}${showCursor()}`);
    this.active = false;
  }

  fullRedraw(): void {
    // The regular-buffer renderer always repaints every tracked line.
  }

  render(input: Omit<LayoutInput, "cols" | "rows">): void {
    if (!this.active) return;
    const cols = this.output.columns || 80;
    const rows = Math.min(this.output.rows || 24, MAX_FRAME_ROWS);
    const frame = buildFrame({ ...input, cols, rows, transcriptLayoutCache: this.transcriptLayoutCache });
    let buffer = `${hideCursor()}${this.clearPrompt()}`;

    const physicalRows = frame.lines.length;
    for (let index = 0; index < physicalRows; index += 1) {
      buffer += `${clearLine()}${frame.lines[index] ?? ""}`;
      if (index < physicalRows - 1) buffer += "\n";
    }

    const rowsUp = Math.max(0, physicalRows - frame.cursorRow);
    buffer += rowsUp > 0 ? `${CSI}${rowsUp}F` : "\r";
    if (frame.cursorCol > 1) buffer += `${CSI}${frame.cursorCol - 1}C`;
    buffer += showCursor();

    this.previousRows = physicalRows;
    this.cursorRow = frame.cursorRow;
    this.output.write(buffer);
  }

  commitLines(lines: string[]): void {
    if (!this.active || lines.length === 0) return;
    let buffer = `${hideCursor()}${this.clearPrompt()}`;
    buffer += lines.map((line) => `${line}\r\n`).join("");
    this.output.write(buffer);
  }

  private clearPrompt(): string {
    if (this.previousRows === 0) return "";
    let buffer = this.cursorRow > 1 ? `${CSI}${this.cursorRow - 1}F` : "\r";
    for (let index = 0; index < this.previousRows; index += 1) {
      buffer += clearLine();
      if (index < this.previousRows - 1) buffer += "\n";
    }
    if (this.previousRows > 1) buffer += `${CSI}${this.previousRows - 1}F`;
    else buffer += "\r";
    this.previousRows = 0;
    this.cursorRow = 1;
    return buffer;
  }
}
