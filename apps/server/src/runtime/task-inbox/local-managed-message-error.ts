/** A rejected local message has no delivery receipt and may be reviewed again. */
export class LocalManagedMessageError extends Error {
  constructor(message: string, readonly status: 404 | 409 | 422 = 409) {
    super(message);
    this.name = "LocalManagedMessageError";
  }
}
