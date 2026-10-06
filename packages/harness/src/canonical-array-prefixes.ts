import { Sha256State } from "./sha256.js";

export type CanonicalJsonValue = null | boolean | number | string
  | readonly CanonicalJsonValue[] | { readonly [key: string]: CanonicalJsonValue };

/** Exact contentHash(values.slice(0, length)) for sorted, ascending cutoffs.
 * Each canonical element is serialized and hashed once. Only the closing
 * delimiter and SHA padding are finalized separately for each requested prefix.
 * Input must contain plain JSON values. Executable objects (including custom
 * toJSON methods and getters) throw; their array-index-dependent serialization
 * is not a portable immutable JSON contract.
 */
export function contentHashArrayPrefixes(values: readonly CanonicalJsonValue[], lengths: readonly number[]): string[] {
  let previous = 0;
  for (const length of lengths) {
    if (!Number.isSafeInteger(length) || length < previous || length > values.length)
      throw new RangeError("Canonical array prefix lengths must be ascending and within the array");
    previous = length;
  }
  const state = new Sha256State().update("[");
  let consumed = 0;
  return lengths.map((length) => {
    while (consumed < length) {
      // A singleton array reproduces exact two-space indentation, including
      // Unicode and nested arrays. Validation shares the canonical sorting walk.
      const item = JSON.stringify([sortJsonValue(values[consumed])], null, 2).slice(2, -2);
      state.update(consumed ? ",\n" : "\n").update(item);
      consumed++;
    }
    return state.clone().update(consumed ? "\n]\n" : "]\n").digestHex();
  });
}

function sortJsonValue(value: unknown): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return value;
  if (Array.isArray(value)) return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor || descriptor.get || descriptor.set)
      throw new TypeError("Canonical array prefixes require plain JSON values");
    return sortJsonValue(descriptor.value);
  });
  const prototype = value && typeof value === "object" ? Object.getPrototypeOf(value) : undefined;
  if (value && typeof value === "object" && (prototype === Object.prototype || prototype === null)) {
    return Object.fromEntries(Object.keys(value).sort((a, b) => a.localeCompare(b)).map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (descriptor.get || descriptor.set) throw new TypeError("Canonical array prefixes require plain JSON values");
      return [key, sortJsonValue(descriptor.value)];
    }));
  }
  throw new TypeError("Canonical array prefixes require plain JSON values");
}
