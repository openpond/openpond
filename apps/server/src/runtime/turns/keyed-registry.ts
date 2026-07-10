export class KeyedRegistry<T> {
  readonly #entries = new Map<string, T>();

  constructor(readonly label: string) {}

  get size(): number {
    return this.#entries.size;
  }

  has(key: string): boolean {
    return this.#entries.has(key);
  }

  get(key: string): T | undefined {
    return this.#entries.get(key);
  }

  set(key: string, value: T): this {
    this.#entries.set(key, value);
    return this;
  }

  delete(key: string): boolean {
    return this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }

  values(): IterableIterator<T> {
    return this.#entries.values();
  }

  assertEmpty(): void {
    if (this.#entries.size === 0) return;
    throw new Error(`${this.label} registry leaked ${this.#entries.size} entr${this.#entries.size === 1 ? "y" : "ies"}.`);
  }
}
