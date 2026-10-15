/** The command already wrote its complete machine-readable failure receipt.
 * The CLI entry point must preserve its nonzero exit without printing again. */
export class CliReportedError extends Error {
  readonly exitCode = 1;

  constructor(message: string) {
    super(message);
    this.name = "CliReportedError";
  }
}
