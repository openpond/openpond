/** Bound the trusted engine's linear memory as well as the worker's JS heap.
 * V8 worker resourceLimits do not constrain WebAssembly or ArrayBuffer memory.
 * Only MVP (32-bit, unshared) memory descriptors are admitted for this engine. */
export function boundWasmMemory(
  bytes: Uint8Array,
  maximumPages: number,
): Uint8Array {
  if (Buffer.from(bytes.subarray(0, 8)).toString("hex") !== "0061736d01000000")
    throw new Error("Unexpected workbook WASM format.");
  function number(offset: number): { value: number; next: number } {
    let value = 0,
      shift = 0;
    for (
      let index = offset;
      index < bytes.length && shift <= 28;
      index++, shift += 7
    ) {
      const byte = bytes[index]!;
      value += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) return { value, next: index + 1 };
    }
    throw new Error("Invalid workbook WASM integer.");
  }
  function encode(value: number): number[] {
    const output: number[] = [];
    do {
      const byte = value & 127;
      value = Math.floor(value / 128);
      output.push(byte | (value ? 128 : 0));
    } while (value);
    return output;
  }
  let memories = 0;
  const sections: Uint8Array[] = [bytes.subarray(0, 8)];
  for (let start = 8; start < bytes.length; ) {
    const kind = bytes[start]!,
      length = number(start + 1),
      end = length.next + length.value;
    if (end > bytes.length)
      throw new Error("Invalid workbook WASM section length.");
    if (kind === 5) {
      const count = number(length.next);
      if (count.value !== 1)
        throw new Error("Workbook engine must own exactly one memory.");
      const flags = number(count.next),
        minimum = number(flags.next);
      if (flags.value > 1 || minimum.value > maximumPages)
        throw new Error("Unsupported workbook engine memory descriptor.");
      const originalMaximum = flags.value === 1 ? number(minimum.next) : null;
      if ((originalMaximum?.next ?? minimum.next) !== end)
        throw new Error("Unexpected workbook engine memory payload.");
      const maximum = Math.min(
        maximumPages,
        originalMaximum?.value ?? maximumPages,
      );
      const payload = Uint8Array.from([
        ...encode(1),
        ...encode(1),
        ...encode(minimum.value),
        ...encode(maximum),
      ]);
      sections.push(
        Uint8Array.from([kind, ...encode(payload.length)]),
        payload,
      );
      memories++;
    } else sections.push(bytes.subarray(start, end));
    start = end;
  }
  if (memories !== 1)
    throw new Error("Workbook engine has no bounded internal memory.");
  return new Uint8Array(Buffer.concat(sections));
}
