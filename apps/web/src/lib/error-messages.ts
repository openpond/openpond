const CONNECTION_ERROR_PATTERNS = [
  /^(?:(?:type)?error:\s*)?failed to fetch\.?$/i,
  /^networkerror when attempting to fetch resource\.?$/i,
  /^load failed\.?$/i,
];

export function errorMessageForToast(error: unknown, fallback = "Something went wrong."): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = message.trim();
  if (!normalized) return fallback;
  if (isConnectionErrorMessage(normalized)) {
    return "Couldn’t connect to OpenPond.";
  }
  return normalized;
}

export function isConnectionErrorMessage(message: string): boolean {
  const normalized = message.trim();
  return CONNECTION_ERROR_PATTERNS.some((pattern) => pattern.test(normalized));
}
