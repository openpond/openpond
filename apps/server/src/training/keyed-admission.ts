export class KeyedAdmission {
  private readonly activeKeys = new Set<string>();

  constructor(private readonly label: string) {}

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    if (this.activeKeys.has(key)) {
      throw new Error(`${this.label} is already being admitted.`);
    }
    this.activeKeys.add(key);
    try {
      return await operation();
    } finally {
      this.activeKeys.delete(key);
    }
  }
}
