/** Identifies hosted SDK calls as CLI activity; authentication stays in the SDK. */
export const hostedCliFetch: typeof fetch = (input, init) => {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
  headers.set("x-openpond-client", "openpond-cli");
  return fetch(input, { ...init, headers });
};
