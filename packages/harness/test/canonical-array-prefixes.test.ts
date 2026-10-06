import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, contentHash } from "../src/common.js";
import { contentHashArrayPrefixes, type CanonicalJsonValue } from "../src/canonical-array-prefixes.js";
import { Sha256State, sha256Hex } from "../src/sha256.js";

describe("immutable canonical array-prefix hashes", () => {
  // A changed prefix digest invalidates retained conversation IDs and receipts.
  // Compare every cutoff with both the original serializer and independent SHA.
  it("preserves every prefix across nesting, Unicode, JSON nulls and SHA padding boundaries", () => {
    const values: CanonicalJsonValue[] = [null, true, -0, NaN, [], {},
      { z: "🙂 e\u0301 \ud800", a: [{ newline: "\n", quote: '"', escaped: "\\" }, null] },
      ...Array.from({ length: 140 }, (_, index) => ({
        text: "x".repeat(index), nested: [index, { z: false, a: "汉字" }],
      })),
    ];
    const lengths = Array.from({ length: values.length + 1 }, (_, index) => index);
    const hashes = contentHashArrayPrefixes(values, lengths);
    for (const [index, length] of lengths.entries()) {
      const prefix = values.slice(0, length);
      expect(hashes[index]).toBe(contentHash(prefix));
      expect(hashes[index]).toBe(createHash("sha256").update(canonicalJson(prefix)).digest("hex"));
    }
    expect(contentHashArrayPrefixes(values, [0, 0, 1, 1, values.length]))
      .toEqual([hashes[0], hashes[0], hashes[1], hashes[1], hashes.at(-1)]);
    expect(contentHashArrayPrefixes([], [0])).toEqual([contentHash([])]);
    expect(contentHashArrayPrefixes(values, [])).toEqual([]);
    for (const invalid of [[-1], [2, 1], [1.5], [values.length + 1], [NaN]])
      expect(() => contentHashArrayPrefixes(values, invalid)).toThrow(RangeError);
    let executed = false;
    const executable = { toJSON(key: string) { executed = true; return key; } };
    const accessor = Object.defineProperty({}, "value", { enumerable: true, get() { executed = true; return 1; } });
    const arrayAccessor = Object.defineProperty([null], 0, { get() { executed = true; return 1; } });
    for (const unsupported of [undefined, executable, { nested: executable }, accessor, arrayAccessor, new Date()])
      expect(() => contentHashArrayPrefixes([null, unsupported as never], [2])).toThrow(TypeError);
    expect(executed).toBe(false);
  });

  // A clone or padding mutation would corrupt later cutoffs despite an early
  // prefix passing. Independent digests check chunk boundaries and continuation.
  it("keeps byte-stream snapshots independent through partial blocks and finalization", () => {
    for (const size of [0, 1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 129, 1024]) {
      const bytes = Uint8Array.from({ length: size }, (_, index) => index % 251);
      const state = new Sha256State();
      for (let offset = 0; offset < bytes.length; offset += 13)
        state.update(bytes.subarray(offset, offset + 13));
      const expected = createHash("sha256").update(bytes).digest("hex");
      expect(state.digestHex()).toBe(expected);
      expect(sha256Hex(bytes)).toBe(expected);
      const suffix = new TextEncoder().encode("🙂 continuation");
      const clone = state.clone().update(suffix);
      expect(clone.digestHex()).toBe(createHash("sha256").update(bytes).update(suffix).digest("hex"));
      expect(state.digestHex()).toBe(expected);
      state.update(suffix);
      expect(state.digestHex()).toBe(clone.digestHex());
    }
  });
});
