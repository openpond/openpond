/** Matches the local reader's digest of the actual file bytes. */
export async function fileContentVersion(contentBase64: string) {
  const bytes = Uint8Array.from(atob(contentBase64), character => character.charCodeAt(0));
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer);
  return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
