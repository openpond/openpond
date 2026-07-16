import { EventEmitter } from "node:events";
import type { ReadStream } from "node:tty";

import { describe, expect, test } from "vitest";

import { RawInput } from "../apps/terminal/src/ui/input";

class FakeTtyInput extends EventEmitter {
  isRaw = false;
  readonly rawModes: boolean[] = [];
  resumeCount = 0;
  pauseCount = 0;

  setRawMode(value: boolean): this {
    this.isRaw = value;
    this.rawModes.push(value);
    return this;
  }

  resume(): this {
    this.resumeCount += 1;
    return this;
  }

  pause(): this {
    this.pauseCount += 1;
    return this;
  }
}

describe("terminal raw input ownership", () => {
  test("restores raw mode, removes its listener, and pauses stdin on stop", () => {
    const input = new FakeTtyInput();
    const keys: string[] = [];
    const rawInput = new RawInput(input as unknown as ReadStream, (key) => keys.push(key));

    rawInput.start();
    input.emit("data", Buffer.from("a"));
    rawInput.stop();
    input.emit("data", Buffer.from("b"));

    expect(keys).toEqual(["a"]);
    expect(input.rawModes).toEqual([true, false]);
    expect(input.resumeCount).toBe(1);
    expect(input.pauseCount).toBe(1);
  });
});
