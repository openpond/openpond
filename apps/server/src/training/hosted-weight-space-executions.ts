export class HostedWeightSpaceExecutionError extends Error {
  readonly status = 409;
  constructor(readonly code: string, message: string) { super(message); }
}
