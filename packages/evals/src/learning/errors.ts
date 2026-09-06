/** Stable domain failures that hosts may expose without treating rejected work
 * as an infrastructure failure. Unexpected exceptions remain server errors. */
export class LearningDomainError extends Error {
  constructor(readonly code: string, readonly status: 400 | 403 | 404 | 409 | 422 = 422, description?: string) {
    super(description ? `${code}: ${description}` : code);
    this.name = "LearningDomainError";
  }
}
