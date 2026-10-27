export class OpenPondLearningError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: unknown,
  ) {
    super(message);
    this.name = "OpenPondLearningError";
  }
}
