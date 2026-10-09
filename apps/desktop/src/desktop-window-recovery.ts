/** One automatic retry per recovery episode; concurrent failure events share it. */
export class DesktopWindowRecovery {
  #pending: Promise<void> | null = null;
  #retried = false;

  constructor(
    private readonly load: () => Promise<void>,
    private readonly showError: (error: unknown) => Promise<void>,
  ) {}

  retry(): Promise<void> {
    if (this.#pending) return this.#pending;
    this.#retried = false;
    return this.#run(async () => {
      try { await this.load(); }
      catch (error) { await this.#recover(error); }
    });
  }

  failed(error: unknown): Promise<void> {
    if (this.#pending) return this.#pending;
    return this.#run(() => this.#recover(error));
  }

  #run(action: () => Promise<void>): Promise<void> {
    this.#pending = Promise.resolve().then(action).finally(() => { this.#pending = null; });
    return this.#pending;
  }

  async #recover(error: unknown): Promise<void> {
    if (!this.#retried) {
      this.#retried = true;
      try { await this.load(); return; }
      catch (retryError) { error = retryError; }
    }
    await this.showError(error);
  }
}
