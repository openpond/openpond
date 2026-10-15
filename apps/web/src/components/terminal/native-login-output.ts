// Interpret only the browser handoff from Claude's CLI. Authentication and
// credentials remain owned by the CLI; terminal output is transient UI state.
const AUTH_HOSTS = new Set(["claude.ai", "console.anthropic.com", "platform.claude.com", "console.claude.com"]);

export function readNativeLoginOutput(output: string) {
  const text = output
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/gu, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\r/gu, "");
  let url: string | null = null;
  // Wait for the trailing delimiter so a split WebSocket chunk cannot expose
  // a truncated OAuth URL. Never open an arbitrary link printed by a process.
  for (const match of text.matchAll(/https:\/\/[^\s<>"']+(?=\s)/gu)) {
    try {
      const candidate = new URL(match[0]);
      if (candidate.protocol !== "https:" || candidate.username || candidate.password || candidate.port || !AUTH_HOSTS.has(candidate.hostname)) continue;
      if (candidate.pathname !== "/oauth/authorize") continue;
      if (candidate.searchParams.get("response_type") !== "code" || !candidate.searchParams.get("client_id") || !candidate.searchParams.get("state") || !candidate.searchParams.get("code_challenge")) continue;
      url = candidate.href;
    } catch { /* Incomplete or unsupported links remain available in terminal details. */ }
  }
  return {
    url,
    needsCode: /(?:paste|enter)\s+(?:(?:the|your)\s+)?(?:(?:authorization|authentication|login)\s+)?code\b/iu.test(text),
    needsEnter: /login successful[\s\S]*(?:press|hit)\s+(?:the\s+)?enter\b/iu.test(text),
  };
}

export function nativeLoginCodeInput(value: string): string | null {
  const code = value.trim();
  return code && code.length <= 4096 && !/[\s\x00-\x1f\x7f]/u.test(code) ? `${code}\r` : null;
}
