import { textFromUnknown } from "../../utils.js";

const CONTEXT_OVERFLOW_PATTERNS = [
  /context[_ ]length[_ ]exceeded/i,
  /maximum context length/i,
  /exceeds? (?:the )?context window/i,
  /prompt is too long/i,
  /input is too long/i,
  /too many (?:input )?tokens/i,
  /context window.{0,80}(?:full|limit|token)/i,
  /(?:input|prompt).{0,40}token.{0,40}(?:exceed|limit)/i,
];

export function isProviderContextOverflowError(error: unknown): boolean {
  const message = textFromUnknown(error);
  return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(message));
}

export async function runWithSingleContextOverflowRecovery<TResult>(input: {
  runAttempt(context: {
    attempt: 0 | 1;
    markOutputEscaped(): void;
  }): Promise<TResult>;
  recover(error: unknown): Promise<boolean>;
}): Promise<TResult> {
  let outputEscaped = false;
  const markOutputEscaped = () => {
    outputEscaped = true;
  };
  try {
    return await input.runAttempt({ attempt: 0, markOutputEscaped });
  } catch (error) {
    if (outputEscaped || !isProviderContextOverflowError(error)) throw error;
    const recovered = await input.recover(error);
    if (!recovered) throw error;
    return input.runAttempt({ attempt: 1, markOutputEscaped });
  }
}
