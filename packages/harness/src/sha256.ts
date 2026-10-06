// FIPS 180-4 SHA-256 implemented over platform-neutral typed arrays so the
// portable contracts keep the same synchronous content-hash API in any host.
const INITIAL_STATE = new Uint32Array([
  0x6a09e667,
  0xbb67ae85,
  0x3c6ef372,
  0xa54ff53a,
  0x510e527f,
  0x9b05688c,
  0x1f83d9ab,
  0x5be0cd19,
]);

const ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Cloneable byte-stream state; digest leaves the state available for further updates. */
export class Sha256State {
  private state = new Uint32Array(INITIAL_STATE);
  private pending = new Uint8Array(64);
  private pendingLength = 0;
  private byteLength = 0;
  private words = new Uint32Array(64);

  /** Strings are independently UTF-8 encoded chunks. Use bytes when a text
   * stream may split a surrogate pair between updates. */
  update(value: string | Uint8Array): this {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
    if (!Number.isSafeInteger(this.byteLength + bytes.length)) throw new RangeError("SHA-256 input is too large");
    this.byteLength += bytes.length;
    let offset = 0;
    if (this.pendingLength) {
      const count = Math.min(64 - this.pendingLength, bytes.length);
      this.pending.set(bytes.subarray(0, count), this.pendingLength);
      this.pendingLength += count;
      offset += count;
      if (this.pendingLength === 64) {
        this.compress(this.pending);
        this.pendingLength = 0;
      }
    }
    while (offset + 64 <= bytes.length) {
      this.compress(bytes.subarray(offset, offset + 64));
      offset += 64;
    }
    if (offset < bytes.length) {
      this.pending.set(bytes.subarray(offset));
      this.pendingLength = bytes.length - offset;
    }
    return this;
  }

  clone(): Sha256State {
    const copy = new Sha256State();
    copy.state.set(this.state);
    copy.pending.set(this.pending);
    copy.pendingLength = this.pendingLength;
    copy.byteLength = this.byteLength;
    return copy;
  }

  digestHex(): string {
    const copy = this.clone();
    const padding = new Uint8Array(copy.pendingLength < 56 ? 64 : 128);
    padding.set(copy.pending.subarray(0, copy.pendingLength));
    padding[copy.pendingLength] = 0x80;
    const bitLength = copy.byteLength * 8;
    const view = new DataView(padding.buffer);
    view.setUint32(padding.length - 8, Math.floor(bitLength / 0x1_0000_0000), false);
    view.setUint32(padding.length - 4, bitLength >>> 0, false);
    copy.compress(padding.subarray(0, 64));
    if (padding.length === 128) copy.compress(padding.subarray(64));
    return Array.from(copy.state, (word) => word.toString(16).padStart(8, "0")).join("");
  }

  private compress(bytes: Uint8Array): void {
    const view = new DataView(bytes.buffer, bytes.byteOffset, 64);
    const state = this.state, words = this.words;
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const previous = words[index - 15]!;
      const recent = words[index - 2]!;
      const sigma0 = rotateRight(previous, 7) ^ rotateRight(previous, 18) ^ (previous >>> 3);
      const sigma1 = rotateRight(recent, 17) ^ rotateRight(recent, 19) ^ (recent >>> 10);
      words[index] = (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) >>> 0;
    }

    let a = state[0]!;
    let b = state[1]!;
    let c = state[2]!;
    let d = state[3]!;
    let e = state[4]!;
    let f = state[5]!;
    let g = state[6]!;
    let h = state[7]!;

    for (let index = 0; index < 64; index += 1) {
      const choice = (e & f) ^ (~e & g);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const first = (h + sum1 + choice + ROUND_CONSTANTS[index]! + words[index]!) >>> 0;
      const second = (sum0 + majority) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + first) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (first + second) >>> 0;
    }

    state[0] = (state[0]! + a) >>> 0;
    state[1] = (state[1]! + b) >>> 0;
    state[2] = (state[2]! + c) >>> 0;
    state[3] = (state[3]! + d) >>> 0;
    state[4] = (state[4]! + e) >>> 0;
    state[5] = (state[5]! + f) >>> 0;
    state[6] = (state[6]! + g) >>> 0;
    state[7] = (state[7]! + h) >>> 0;
  }
}

export function sha256Hex(value: string | Uint8Array): string {
  return new Sha256State().update(value).digestHex();
}

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}
