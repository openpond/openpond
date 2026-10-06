/** An empty/incomplete session is discovered history, but not a training case. */
export class NativeSessionNotReadyError extends Error {
  constructor() { super("This session has no retained user request yet."); }
}
